import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import type { MessagesResponse, QueuedStateResponse } from '@hapi/protocol'

const tokenFile = process.argv[2]
if (!tokenFile) throw new Error('Usage: node probe-live-delivery.ts <private-token-file>')
const base = 'https://h.642222.xyz'
const token = readFileSync(tokenFile, 'utf8').trim().split(':')[0] + ':diagnostic-' + randomUUID()
let socket: Socket | undefined
let sessionId: string | undefined
let jwt: string | undefined
async function request<T = unknown>(path: string, body?: unknown, authorization?: string, method = 'POST'): Promise<T> {
    const response = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'curl/8.14.1',
            ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json() as Promise<T>
}
try {
    jwt = (await request<{ token: string }>('/api/auth', { accessToken: token })).token
    sessionId = (await request<{ session: { id: string } }>('/cli/sessions', { tag: randomUUID(),
        metadata: { host: 'isolated-diagnostic', path: '/tmp/hapi-diagnostic', flavor: 'codex' },
        agentState: { requests: {} } }, token)).session.id
    socket = io(base + '/cli', { transports: ['websocket'], reconnection: false,
        auth: { token, sessionId }, extraHeaders: { 'User-Agent': 'curl/8.14.1' } })
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI connection timeout')), 15_000)
        socket!.once('connect', () => { clearTimeout(timer); resolve() })
        socket!.once('connect_error', () => { clearTimeout(timer); reject(new Error('CLI connection rejected')) })
    })
    const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
    const received = new Set<string>()
    socket.on('update', async update => {
        const message = update.body?.message
        if (update.body?.t !== 'new-message' || typeof message?.localId !== 'string') return
        if (received.has(message.localId)) return
        received.add(message.localId)
        socket!.emit('messages-consumed', { sid: sessionId, localIds: [message.localId] })
        try {
            await socket!.timeout(5000).emitWithAck('ping')
            pending.get(message.localId)?.resolve()
        } catch { pending.get(message.localId)?.reject(new Error('Consumption barrier timed out')) }
    })
    socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false })
    await socket.timeout(5000).emitWithAck('ping')
    const timings: number[] = []
    const localIds: string[] = []
    for (let index = 0; index < 10; index++) {
        const localId = randomUUID()
        localIds.push(localId)
        let timeout: NodeJS.Timeout | undefined
        const delivered = new Promise<void>((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Delivery timeout')), 10_000)
            pending.set(localId, { resolve, reject })
        })
        // Observe rejection even if the HTTP request fails first.
        void delivered.catch(() => {})
        const start = performance.now()
        try {
            await request(`/api/sessions/${sessionId}/messages`, { text: 'Isolated delivery probe', localId }, jwt)
            await delivered
            // Retry the same POST to verify idempotent persistence.
            await request(`/api/sessions/${sessionId}/messages`, { text: 'Isolated delivery probe', localId }, jwt)
            timings.push(Math.round((performance.now() - start) * 100) / 100)
        } finally { clearTimeout(timeout); pending.delete(localId) }
    }
    const state = await request<QueuedStateResponse>(`/api/sessions/${sessionId}/messages/queued-state`, { localIds }, jwt)
    const page = await request<MessagesResponse>(`/api/sessions/${sessionId}/messages?limit=50`, undefined, jwt, 'GET')
    if (state.queuedLocalIds.length || state.indeterminateLocalIds?.length || state.invokedLocalMessages.length !== 10
        || page.messages.length !== 10 || received.size !== 10) throw new Error('Delivery ledger mismatch')
    console.log(JSON.stringify({ delivered: received.size, persisted: page.messages.length,
        pending: state.queuedLocalIds.length, indeterminate: state.indeterminateLocalIds?.length ?? 0,
        sendConsumeAndRetryMs: timings }))
} finally {
    if (socket?.connected && sessionId) {
        socket.emit('session-end', { sid: sessionId, time: Date.now() })
        await socket.timeout(5000).emitWithAck('ping').catch(() => {})
    }
    socket?.disconnect()
    if (sessionId && jwt) {
        await request(`/api/sessions/${sessionId}`, undefined, jwt, 'DELETE')
        console.log(JSON.stringify({ diagnosticSessionDeleted: true }))
    }
}
