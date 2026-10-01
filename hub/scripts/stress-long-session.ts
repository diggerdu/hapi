import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'
import { SignJWT } from 'jose'
import { io, type Socket } from 'socket.io-client'

const { values } = parseArgs({ options: {
    worker: { type: 'boolean' }, compact: { type: 'boolean' }, messages: { type: 'string', default: '100000' },
    sessions: { type: 'string', default: '2' }, clients: { type: 'string', default: '1' },
    rate: { type: 'string', default: '80' }, duration: { type: 'string', default: '15' },
    mode: { type: 'string', default: 'mixed' }, cpu: { type: 'string' }, profile: { type: 'string' }
} })

function integer(value: string | undefined, name: string): number {
    const result = Number(value)
    if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid ${name}`)
    return result
}

const options = {
    messages: integer(values.messages, 'messages'), sessions: integer(values.sessions, 'sessions'),
    clients: integer(values.clients, 'clients'), rate: integer(values.rate, 'rate'),
    duration: integer(values.duration, 'duration'), mode: values.mode!, compact: values.compact === true
}
if (!['replay', 'mixed'].includes(options.mode)) throw new Error('Mode must be replay or mixed')

type SessionFixture = { id: string; metadata: Record<string, unknown>; metadataVersion: number; stateVersion: number }
type Ready = { type: 'ready'; port: number; jwt: string; sessions: SessionFixture[] }
type Ack = { result: string; version?: number; metadata?: Record<string, unknown> }

function distribution(samples: number[]): Record<string, number | null> {
    const sorted = [...samples].sort((left, right) => left - right)
    return { count: sorted.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
        p99Ms: sorted[Math.floor(sorted.length * 0.99)] ?? null, maxMs: sorted.at(-1) ?? null }
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

async function worker(): Promise<void> {
    process.once('disconnect', () => process.exit(1))
    const { Database } = await import('bun:sqlite')
    const { createConfiguration } = await import('../src/configuration')
    const { Store } = await import('../src/store')
    const { SSEManager } = await import('../src/sse/sseManager')
    const { VisibilityTracker } = await import('../src/visibility/visibilityTracker')
    const { createSocketServer } = await import('../src/socket/server')
    const { SyncEngine } = await import('../src/sync/syncEngine')
    const { startWebServer } = await import('../src/web/server')
    const configuration = await createConfiguration()
    const store = new Store(configuration.dbPath)
    const fixtureDb = new Database(configuration.dbPath)
    const sessions: SessionFixture[] = []
    for (let index = 0; index < options.sessions; index++) {
        const metadata = { path: '/tmp/stress', host: 'synthetic', flavor: 'codex',
            history: Array.from({ length: Math.floor(options.messages / 100) }, (_, turn) => ({
                id: `turn-${turn}`, position: turn * 100, summary: 'Synthetic conversation history'
            })) }
        const session = store.sessions.getOrCreateSession(`stress-${index}`, metadata, { requests: {} }, 'default')
        fixtureDb.query(`
            WITH RECURSIVE sequence(value) AS (
                SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
            )
            INSERT INTO messages (id, session_id, content, created_at, seq, invoked_at, local_id)
            SELECT ? || value, ?, '{"role":"user","content":{"type":"text","text":"Synthetic history"}}',
                ?, value, ?, ? || value FROM sequence
        `).run(options.messages, `${index}-history-`, session.id, session.createdAt, session.createdAt, `${index}-local-`)
        sessions.push({ id: session.id, metadata, metadataVersion: session.metadataVersion, stateVersion: session.agentStateVersion })
    }
    fixtureDb.close()
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const tracker = new VisibilityTracker()
    const manager = new SSEManager(30000, tracker)
    let sync: InstanceType<typeof SyncEngine> | undefined
    const socket = createSocketServer({ store, jwtSecret: secret,
        getSession: identifier => sync?.getSession(identifier) ?? null,
        onWebappEvent: event => sync?.handleRealtimeEvent(event),
        onSessionAlive: payload => sync?.handleSessionAlive(payload),
        onSessionReady: payload => sync?.handleSessionReady(payload),
        onSessionEnd: payload => sync?.handleSessionEnd(payload),
        onSessionActivity: (identifier, timestamp) => sync?.recordSessionActivity(identifier, timestamp),
        onAgentProgress: (identifier, timestamp) => sync?.recordAgentProgress(identifier, timestamp),
        onMessagesConsumed: identifier => sync?.clearQueuedThinkingGrace(identifier),
        onSweepImmediateQueued: (identifier, timestamp) => sync?.sweepImmediateQueuedOnSessionEnd(identifier, timestamp)
    })
    sync = new SyncEngine(store, socket.io, socket.rpcRegistry, manager)
    const server = await startWebServer({ getSyncEngine: () => sync ?? null, getSseManager: () => manager,
        getVisibilityTracker: () => tracker, jwtSecret: secret, store, vapidPublicKey: '', socketEngine: socket.engine })
    const jwt = await new SignJWT({ uid: 1, ns: 'default' }).setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h').sign(secret)
    let delays: number[] = []
    let lastTick = performance.now()
    let maxRss = process.memoryUsage().rss
    let started = performance.now()
    let startedCpu = process.cpuUsage()
    let measuring = false
    const timer = setInterval(() => {
        const now = performance.now()
        if (measuring) {
            delays.push(Math.max(0, now - lastTick - 10))
            maxRss = Math.max(maxRss, process.memoryUsage().rss)
        }
        lastTick = now
    }, 10)
    process.on('message', async (request: { action: string; requestId: number }) => {
        if (request.action === 'start') {
            delays = []
            maxRss = process.memoryUsage().rss
            startedCpu = process.cpuUsage()
            started = lastTick = performance.now()
            measuring = true
            process.send?.({ requestId: request.requestId, type: 'started' })
        } else if (request.action === 'stats') {
            measuring = false
            const durationMs = performance.now() - started
            const cpu = process.cpuUsage(startedCpu)
            process.send?.({ requestId: request.requestId, type: 'stats',
                durationMs, cpuPercent: (cpu.user + cpu.system) / (durationMs * 10),
                maxRssMiB: maxRss / 1024 / 1024, eventLoopDelay: distribution(delays),
                sessions: sessions.map(session => {
                    const stored = store.sessions.getSession(session.id)!
                    return { id: session.id, messages: store.messages.countMessages(session.id),
                        metadataVersion: stored.metadataVersion, stateVersion: stored.agentStateVersion }
                }) })
        } else if (request.action === 'shutdown') {
            clearInterval(timer)
            sync?.stop()
            manager.stop()
            server.stop(true)
            await new Promise<void>(resolve => socket.io.close(() => resolve()))
            store.close()
            process.exit(0)
        }
    })
    if (server.port === undefined) throw new Error('Hub did not expose a listening port')
    process.send?.({ type: 'ready', port: server.port, jwt, sessions } satisfies Ready)
}

async function driver(): Promise<void> {
    if (typeof Bun !== 'undefined') throw new Error('Run the load-test driver with Node; only the Hub worker uses Bun')
    const directory = mkdtempSync(join(tmpdir(), 'hapi-socket-stress-'))
    const reservation = createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('Cannot allocate port')
    const port = address.port
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const token = crypto.randomUUID()
    const runtime = process.env.BUN_BIN ?? 'bun'
    const command = values.cpu ? 'taskset' : runtime
    const scriptPath = fileURLToPath(import.meta.url)
    const args = [...(values.cpu ? ['-c', values.cpu, runtime] : []),
        ...(values.profile ? ['--cpu-prof', `--cpu-prof-dir=${values.profile}`] : []),
        scriptPath, ...process.argv.slice(2), '--worker']
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HAPI_HOME: directory, DB_PATH: join(directory, 'fixture.db'),
            CLI_API_TOKEN: token, HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(port),
            HAPI_PUBLIC_URL: `http://127.0.0.1:${port}`, CORS_ORIGINS: '*',
            TELEGRAM_BOT_TOKEN: '', HAPI_ANDROID_PUSH: 'off', HAPI_IOS_PUSH: 'off' } })
    child.stdout?.resume()
    let diagnostic = ''
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000) })
    const sockets: Socket[] = []
    const controllers: AbortController[] = []
    const streamReaders: Array<{ cancel(reason?: unknown): Promise<void> }> = []
    let traffic: ReturnType<typeof setInterval> | undefined
    const pendingControl = new Map<number, (response: Record<string, unknown>) => void>()
    let requestId = 0
    child.on('message', (response: Record<string, unknown>) => {
        const resolve = pendingControl.get(Number(response.requestId))
        if (resolve) { pendingControl.delete(Number(response.requestId)); resolve(response) }
    })
    const control = (action: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
        if (!child.connected) { reject(new Error('Worker disconnected')); return }
        const identifier = ++requestId
        const timeout = setTimeout(() => { pendingControl.delete(identifier); reject(new Error(`Worker ${action} timed out`)) }, 10000)
        pendingControl.set(identifier, response => { clearTimeout(timeout); resolve(response) })
        child.send({ action, requestId: identifier })
    })
    let active = true
    let interruptWait: (() => void) | undefined
    const interrupt = () => {
        active = false
        if (traffic) clearInterval(traffic)
        for (const controller of controllers) controller.abort()
        for (const socket of sockets) socket.disconnect()
        child.kill('SIGTERM')
        process.exitCode = 130
        interruptWait?.()
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    try {
        const ready = await new Promise<Ready>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker startup timed out')), 120000)
            child.on('message', (message: Ready) => {
                if (message.type === 'ready') { clearTimeout(timeout); resolve(message) }
            })
            child.once('error', error => { clearTimeout(timeout); reject(error) })
            child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Worker exited ${code}: ${diagnostic}`)) })
        })
        const base = `http://127.0.0.1:${ready.port}`
        const headers = { Authorization: `Bearer ${ready.jwt}`, 'Accept-Encoding': 'gzip' }
        const readers: Promise<void>[] = []
        const openStream = async (sessionId: string, hold: boolean): Promise<number> => {
            const controller = new AbortController()
            controllers.push(controller)
            const timeout = setTimeout(() => controller.abort(), hold ? (options.duration + 30) * 1000 : 5000)
            const started = performance.now()
            try {
                const response = await fetch(`${base}/api/events?sessionId=${sessionId}&visibility=visible`, { headers, signal: controller.signal })
                if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`)
                const reader = response.body.getReader()
                let prefix = ''
                const decoder = new TextDecoder()
                while (!prefix.includes('\n\n')) {
                    const chunk = await reader.read()
                    if (chunk.done) throw new Error('SSE ended before handshake')
                    prefix += decoder.decode(chunk.value, { stream: true })
                    if (prefix.length > 1024 * 1024) throw new Error('SSE handshake exceeds limit')
                }
                if (!prefix.includes('connection-changed')) throw new Error('Missing SSE handshake')
                const duration = performance.now() - started
                if (hold) {
                    streamReaders.push(reader)
                    readers.push((async () => {
                        try { while (!(await reader.read()).done) {} } catch { } finally { reader.releaseLock() }
                    })())
                } else { await reader.cancel(); controller.abort(); reader.releaseLock() }
                return duration
            } finally {
                if (!hold) controller.abort()
                clearTimeout(timeout)
            }
        }
        const clientFixtures: Array<SessionFixture & { socket: Socket; inFlight: number }> = []
        for (const fixture of ready.sessions) {
            await openStream(fixture.id, true)
            for (let index = 0; index < options.clients; index++) {
                const socket = io(`${base}/cli`, { transports: ['websocket'], reconnection: false,
                    auth: { token, sessionId: fixture.id } })
                sockets.push(socket)
                await new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve)
                    socket.once('connect_error', reject)
                })
                clientFixtures.push({ ...fixture, socket, inFlight: 0 })
            }
        }
        await control('start')
        const wireBytes = () => sockets.reduce((total, socket) => {
            const transport = socket.io.engine.transport as unknown as {
                ws?: { _socket?: { bytesRead: number; bytesWritten: number } }
            }
            total.received += transport.ws?._socket?.bytesRead ?? 0
            total.sent += transport.ws?._socket?.bytesWritten ?? 0
            return total
        }, { received: 0, sent: 0 })
        const startingBytes = wireBytes()
        const ackTimes: number[] = []
        const sseTimes: number[] = []
        const apiTimes: number[] = []
        const pending = new Set<Promise<void>>()
        const probeErrorReasons: Record<string, number> = {}
        let sent = 0, offered = 0, backpressured = 0, acknowledged = 0, mismatches = 0, errors = 0, probeErrors = 0
        const started = performance.now()
        const generate = () => {
            const due = Math.floor((performance.now() - started) * options.rate / 1000)
            while (offered < due) {
                const sequence = offered++
                const fixture = clientFixtures[sequence % clientFixtures.length]
                if (fixture.inFlight >= 32) { backpressured++; continue }
                fixture.inFlight++
                sent++
                const operation = options.mode === 'replay' ? sequence % 2 : sequence % 5
                const timestamp = performance.now()
                const expectedVersion = operation === 0 ? fixture.metadataVersion : fixture.stateVersion
                let acknowledgement: Promise<Ack>
                if (operation === 0 || operation === 1) {
                    const metadata = operation === 0
                    acknowledgement = fixture.socket.timeout(5000).emitWithAck(metadata ? 'update-metadata' : 'update-state', {
                        sid: fixture.id, expectedVersion,
                        compactAck: options.compact,
                        ...(metadata ? { metadata: options.mode === 'mixed' ? { ...fixture.metadata, name: `update-${sequence}` } : fixture.metadata }
                            : { agentState: options.mode === 'mixed' ? { requests: {}, counter: sequence } : { requests: {} } })
                    })
                } else {
                    if (operation === 4) fixture.socket.emit('session-alive', { sid: fixture.id, time: Date.now(), thinking: false })
                    else fixture.socket.emit('message', { sid: fixture.id,
                        ...(operation === 2 ? { localId: `stress-${sequence}` } : {}),
                        message: operation === 2
                            ? { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Synthetic assistant output '.repeat(16) } } }
                            : { role: 'user', content: { type: 'text', text: 'Synthetic user input' } }
                    })
                    acknowledgement = fixture.socket.timeout(5000).emitWithAck('ping').then(() => ({ result: 'success' }))
                }
                const promise = acknowledgement.then(response => {
                    acknowledged++
                    ackTimes.push(performance.now() - timestamp)
                    if (response.result === 'version-mismatch') mismatches++
                    else if (response.result === 'unchanged' && (!options.compact || response.version !== expectedVersion)) errors++
                    else if (response.result !== 'success' && response.result !== 'unchanged') errors++
                    if (operation === 0 && response.version !== undefined) fixture.metadataVersion = Math.max(fixture.metadataVersion, response.version)
                    if (operation === 1 && response.version !== undefined) fixture.stateVersion = Math.max(fixture.stateVersion, response.version)
                }).catch(() => { errors++ }).finally(() => { fixture.inFlight--; pending.delete(promise) })
                pending.add(promise)
            }
        }
        traffic = setInterval(generate, 10)
        const probes = (async () => {
            let index = 0
            while (active) {
                const fixture = ready.sessions[index++ % ready.sessions.length]
                try {
                    sseTimes.push(await openStream(fixture.id, false))
                    const beginning = performance.now()
                    const response = await fetch(`${base}/api/sessions/${fixture.id}/messages?limit=50`,
                        { headers, signal: AbortSignal.timeout(5000) })
                    if (!response.ok) throw new Error(`Messages HTTP ${response.status}`)
                    await response.arrayBuffer()
                    apiTimes.push(performance.now() - beginning)
                } catch (error) {
                    if (active) {
                        probeErrors++
                        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
                        probeErrorReasons[reason] = (probeErrorReasons[reason] ?? 0) + 1
                    }
                }
                await sleep(250)
            }
        })()
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { interruptWait = undefined; resolve() }, options.duration * 1000)
            interruptWait = () => {
                clearTimeout(timer)
                interruptWait = undefined
                reject(new Error('Load test interrupted'))
            }
        })
        generate()
        clearInterval(traffic)
        active = false
        await Promise.all([...pending])
        const stats = await control('stats')
        const endingBytes = wireBytes()
        await probes
        console.log(JSON.stringify({ options, offered, sent, backpressured, acknowledged, mismatches, errors, probeErrors,
            probeErrorReasons,
            websocketWireBytes: { received: endingBytes.received - startingBytes.received,
                sent: endingBytes.sent - startingBytes.sent },
            acknowledgedPerSecond: acknowledged / options.duration,
            acknowledgements: distribution(ackTimes), sseHandshake: distribution(sseTimes), messagesApi: distribution(apiTimes), stats }))
        for (const controller of controllers) controller.abort()
        for (const socket of sockets) socket.disconnect()
        await Promise.allSettled(streamReaders.map(reader => reader.cancel()))
        await Promise.all(readers)
    } finally {
        active = false
        if (traffic) clearInterval(traffic)
        for (const controller of controllers) controller.abort()
        for (const socket of sockets) socket.disconnect()
        await Promise.allSettled(streamReaders.map(reader => reader.cancel()))
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
        if (child.exitCode === null && child.signalCode === null) {
            if (child.connected) child.send({ action: 'shutdown', requestId: 0 })
            else child.kill('SIGTERM')
            await Promise.race([exited, sleep(5000)])
            if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
        }
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', interrupt)
        rmSync(directory, { recursive: true, force: true })
    }
}

if (values.worker) await worker()
else await driver()
