import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SSEManager namespace filtering', () => {
    it('routes events to matching namespace', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all namespaces', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                received.push({ id: 'beta', event })
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'connection-changed', data: { status: 'connected' } })

        expect(received).toHaveLength(2)
        expect(received.map((entry) => entry.id).sort()).toEqual(['alpha', 'beta'])
    })

    it('sends toast only to visible connections in a namespace', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'visible', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'hidden',
            namespace: 'alpha',
            all: true,
            visibility: 'hidden',
            send: (event) => {
                received.push({ id: 'hidden', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'other',
            namespace: 'beta',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'other', event })
            },
            sendHeartbeat: () => {}
        })

        const toastEvent: Extract<SyncEvent, { type: 'toast' }> = {
            type: 'toast',
            data: {
                title: 'Test',
                body: 'Toast body',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        }

        const delivered = await manager.sendToast('alpha', toastEvent)

        expect(delivered).toBe(1)
        expect(received).toHaveLength(1)
        expect(received[0]?.id).toBe('visible')
    })
})

describe('SSEManager reconnect replay', () => {
    type Sent = { event: SyncEvent; eventId: string | undefined }

    function subscribeCollecting(
        manager: SSEManager,
        id: string,
        options: { namespace?: string; sessionId?: string | null; all?: boolean; resumeFrom?: string | null } = {}
    ): { sent: Sent[]; resume: 'ok' | 'gap'; replay: Array<{ event: SyncEvent; eventId: string }> } {
        const sent: Sent[] = []
        const result = manager.subscribe({
            id,
            namespace: options.namespace ?? 'alpha',
            all: options.all ?? !options.sessionId,
            sessionId: options.sessionId ?? null,
            resumeFrom: options.resumeFrom ?? null,
            send: (event, eventId) => {
                sent.push({ event, eventId })
            },
            sendHeartbeat: () => {}
        })
        return { sent, resume: result.resume, replay: result.replay }
    }

    it('assigns monotonic ids to broadcast events', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(sent).toHaveLength(2)
        const [first, second] = sent
        expect(first?.eventId).toMatch(/^[0-9a-f-]{8}:1:[0-9a-f]{8}$/)
        expect(second?.eventId).toMatch(/^[0-9a-f-]{8}:2:[0-9a-f]{8}$/)
        expect(first?.eventId?.split(':')[0]).toBe(second?.eventId?.split(':')[0])
        expect(first?.eventId?.split(':')[2]).toBe(second?.eventId?.split(':')[2])
    })

    it('resumes with a filtered replay of missed events', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'beta' })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        const cursor = sent[0]?.eventId
        manager.unsubscribe('a')

        const reconnect = subscribeCollecting(manager, 'b', { sessionId: 's1', resumeFrom: cursor })

        expect(reconnect.resume).toBe('ok')
        // s2 filtered out (session mismatch), beta filtered out (namespace)
        expect(reconnect.replay).toHaveLength(1)
        expect(reconnect.replay[0]?.event).toMatchObject({ sessionId: 's1', namespace: 'alpha' })
        expect(reconnect.replay[0]?.eventId?.split(':')[1]).toBe('4')
    })

    it('resumes ok with empty replay when nothing was missed', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.unsubscribe('a')

        const reconnect = subscribeCollecting(manager, 'b', { resumeFrom: sent[0]?.eventId })

        expect(reconnect.resume).toBe('ok')
        expect(reconnect.replay).toHaveLength(0)

        // no pending queue: live events flow immediately
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        expect(reconnect.sent).toHaveLength(1)
    })

    it('reports a gap for foreign or malformed cursors', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        for (const cursor of ['deadbeef:1', 'not-a-cursor', ':', 'deadbeef:', '']) {
            const { resume, replay } = subscribeCollecting(manager, `c-${cursor}`, { resumeFrom: cursor || null })
            expect(resume).toBe('gap')
            expect(replay).toHaveLength(0)
        }
    })

    it('reports a gap for cursors from the future', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        const [epoch, , tag] = sent[0]?.eventId?.split(':') ?? []
        manager.unsubscribe('a')

        const reconnect = subscribeCollecting(manager, 'b', { resumeFrom: `${epoch}:999:${tag}` })
        expect(reconnect.resume).toBe('gap')
    })

    it('rejects a cursor issued under a different namespace', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a', { namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        const cursor = sent[0]?.eventId
        manager.unsubscribe('a')

        // Same subscription shape, different authenticated namespace (token
        // swap on the same hub): the alpha cursor must not vouch for beta.
        const foreign = subscribeCollecting(manager, 'b', { namespace: 'beta', resumeFrom: cursor })
        expect(foreign.resume).toBe('gap')
        expect(foreign.replay).toHaveLength(0)

        // The same cursor is still valid for its own namespace.
        const home = subscribeCollecting(manager, 'c', { namespace: 'alpha', resumeFrom: cursor })
        expect(home.resume).toBe('ok')
        expect(home.replay).toHaveLength(1)
    })

    it('reports a gap when the cursor has been evicted from the ring', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        // Overflow the 256-entry ring so the first event is evicted
        for (let i = 0; i < 300; i++) {
            manager.broadcast({ type: 'session-updated', sessionId: `s${i}`, namespace: 'alpha' })
        }
        manager.unsubscribe('a')

        const stale = subscribeCollecting(manager, 'b', { resumeFrom: sent[0]?.eventId })
        expect(stale.resume).toBe('gap')

        const fresh = subscribeCollecting(manager, 'c', { resumeFrom: sent[298]?.eventId })
        expect(fresh.resume).toBe('ok')
        expect(fresh.replay).toHaveLength(1)
        expect(fresh.replay[0]?.event).toMatchObject({ sessionId: 's299' })
    })

    it('queues live broadcasts during replay and drains them in order', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'alpha' })
        manager.unsubscribe('a')

        const reconnect = subscribeCollecting(manager, 'b', { resumeFrom: sent[0]?.eventId })
        expect(reconnect.replay).toHaveLength(1)

        // Fires while the caller is still writing the replay: must be queued,
        // not delivered.
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'alpha' })
        expect(reconnect.sent).toHaveLength(0)

        await manager.drainPending('b')
        expect(reconnect.sent).toHaveLength(1)
        expect(reconnect.sent[0]?.event).toMatchObject({ sessionId: 's3' })
        expect(reconnect.sent[0]?.eventId?.split(':')[1]).toBe('3')

        // After the drain the connection is live
        manager.broadcast({ type: 'session-updated', sessionId: 's4', namespace: 'alpha' })
        expect(reconnect.sent).toHaveLength(2)
    })

    it('drains events that arrive while the drain itself is awaiting', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'alpha' })
        manager.unsubscribe('a')

        const order: string[] = []
        let injected = false
        manager.subscribe({
            id: 'b',
            namespace: 'alpha',
            all: true,
            resumeFrom: sent[0]?.eventId,
            send: async (event) => {
                const sessionId = 'sessionId' in event ? event.sessionId : '?'
                order.push(String(sessionId))
                if (!injected) {
                    injected = true
                    // Simulates a broadcast racing in mid-drain
                    manager.broadcast({ type: 'session-updated', sessionId: 's-mid', namespace: 'alpha' })
                    await Promise.resolve()
                }
            },
            sendHeartbeat: () => {}
        })
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'alpha' })

        await manager.drainPending('b')

        expect(order).toEqual(['s3', 's-mid'])
    })

    it('evicts by byte budget while keeping at least one event', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const { sent } = subscribeCollecting(manager, 'a')
        const bigMetadata = 'x'.repeat(1_500_000)
        manager.broadcast({ type: 'session-updated', sessionId: 'big-1', namespace: 'alpha', data: { summary: bigMetadata } as never })
        manager.broadcast({ type: 'session-updated', sessionId: 'big-2', namespace: 'alpha', data: { summary: bigMetadata } as never })
        manager.broadcast({ type: 'session-updated', sessionId: 'big-3', namespace: 'alpha', data: { summary: bigMetadata } as never })
        manager.unsubscribe('a')

        // Only big-3 fits the 2MB budget, so big-2 was evicted UNSEEN by a
        // cursor pointing at big-1 - that cursor cannot resume...
        const stale = subscribeCollecting(manager, 'b', { resumeFrom: sent[0]?.eventId })
        expect(stale.resume).toBe('gap')

        // ...while a cursor at big-2 only needs big-3, which survives. An
        // evicted event the client has already seen never blocks resume.
        const fresh = subscribeCollecting(manager, 'c', { resumeFrom: sent[1]?.eventId })
        expect(fresh.resume).toBe('ok')
        expect(fresh.replay).toHaveLength(1)
        expect(fresh.replay[0]?.event).toMatchObject({ sessionId: 'big-3' })
    })
})

describe('SSEManager agy catalog announcements', () => {
    it('reaches the global connection the app always keeps open, and no other namespace', () => {
        // The app runs one `all` connection plus a session-scoped one
        // (web/src/lib/appSseSubscriptions.ts), so this is what decides whether
        // an open in-session picker hears about a new catalog.
        const manager = new SSEManager(0, new VisibilityTracker())
        const globalAlpha: SyncEvent[] = []
        const sessionAlpha: SyncEvent[] = []
        const machineAlpha: SyncEvent[] = []
        const globalBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha-global', namespace: 'alpha', all: true,
            send: (event) => { globalAlpha.push(event) }, sendHeartbeat: () => {}
        })
        manager.subscribe({
            id: 'alpha-session', namespace: 'alpha', all: false, sessionId: 's1',
            send: (event) => { sessionAlpha.push(event) }, sendHeartbeat: () => {}
        })
        manager.subscribe({
            id: 'alpha-machine', namespace: 'alpha', all: false, machineId: 'm1',
            send: (event) => { machineAlpha.push(event) }, sendHeartbeat: () => {}
        })
        manager.subscribe({
            id: 'beta-global', namespace: 'beta', all: true,
            send: (event) => { globalBeta.push(event) }, sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'machine-agy-models-updated', machineId: 'm1', namespace: 'alpha' })

        expect(globalAlpha).toHaveLength(1)
        expect(machineAlpha).toHaveLength(1)
        // A session-scoped connection carries no machineId, so it is not the
        // route: the global connection is.
        expect(sessionAlpha).toHaveLength(0)
        expect(globalBeta).toHaveLength(0)
    })
})

describe('SSEManager slow connection budgets', () => {
    const event: SyncEvent = { type: 'session-updated', sessionId: 's1', namespace: 'alpha' }

    it('bounds in-flight writes without blocking a healthy connection', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let slowWrites = 0
        let fastWrites = 0
        let closed = 0
        manager.subscribe({
            id: 'slow', namespace: 'alpha', all: true,
            send: () => { slowWrites++; return new Promise<void>(() => {}) },
            sendHeartbeat: () => {}, close: () => { closed++ }
        })
        manager.subscribe({
            id: 'fast', namespace: 'alpha', all: true,
            send: () => { fastWrites++ }, sendHeartbeat: () => {}
        })
        for (let i = 0; i < 4096; i++) manager.broadcast(event)

        expect(slowWrites).toBe(256)
        expect(fastWrites).toBe(4096)
        expect(closed).toBe(1)
        expect(manager.hasSubscription('slow')).toBe(false)
        expect(manager.hasSubscription('fast')).toBe(true)
        manager.stop()
    })

    it('counts UTF-8 bytes rather than string characters', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let writes = 0
        manager.subscribe({
            id: 'slow', namespace: 'alpha', all: true,
            send: () => { writes++; return new Promise<void>(() => {}) }, sendHeartbeat: () => {}
        })
        const large: SyncEvent = { ...event, data: { summary: '\u4e2d'.repeat(400_000) } as never }
        manager.broadcast(large)
        manager.broadcast(large)
        expect(writes).toBe(1)
        expect(manager.hasSubscription('slow')).toBe(false)
    })

    it('allows a single oversized frame without buffering behind it', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let writes = 0
        manager.subscribe({
            id: 'slow', namespace: 'alpha', all: true,
            send: () => { writes++; return new Promise<void>(() => {}) }, sendHeartbeat: () => {}
        })
        manager.broadcast({ ...event, data: { summary: 'x'.repeat(2_100_000) } as never })
        expect(writes).toBe(1)
        expect(manager.hasSubscription('slow')).toBe(true)
        manager.broadcast(event)
        expect(writes).toBe(1)
        expect(manager.hasSubscription('slow')).toBe(false)
    })

    it('releases the write budget after successful delivery', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let resolveWrites: Array<() => void> = []
        manager.subscribe({
            id: 'reader', namespace: 'alpha', all: true,
            send: () => new Promise<void>(resolve => { resolveWrites.push(resolve) }), sendHeartbeat: () => {}
        })
        for (let batch = 0; batch < 3; batch++) {
            for (let i = 0; i < 256; i++) manager.broadcast(event)
            expect(manager.hasSubscription('reader')).toBe(true)
            for (const resolve of resolveWrites) resolve()
            resolveWrites = []
            await Promise.resolve()
        }
        manager.stop()
    })

    it('bounds live events queued behind a reconnect replay', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let cursor: string | undefined
        manager.subscribe({
            id: 'old', namespace: 'alpha', all: true,
            send: (_, id) => { cursor ??= id }, sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        manager.broadcast(event)
        manager.unsubscribe('old')
        let writes = 0
        let closed = 0
        const resumed = manager.subscribe({
            id: 'replay', namespace: 'alpha', all: true, resumeFrom: cursor,
            send: () => { writes++ }, sendHeartbeat: () => {}, close: () => { closed++ }
        })
        expect(resumed.replay).toHaveLength(1)
        for (let i = 0; i < 257; i++) manager.broadcast(event)
        await manager.drainPending('replay')
        expect(writes).toBe(0)
        expect(closed).toBe(1)
        expect(manager.hasSubscription('replay')).toBe(false)
    })

    it('ends an awaiting replay drain when the connection closes', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let cursor: string | undefined
        manager.subscribe({
            id: 'old', namespace: 'alpha', all: true,
            send: (_, id) => { cursor ??= id }, sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        manager.broadcast(event)
        manager.unsubscribe('old')
        manager.subscribe({
            id: 'replay', namespace: 'alpha', all: true, resumeFrom: cursor,
            send: () => new Promise<void>(() => {}), sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        const draining = manager.drainPending('replay')
        manager.unsubscribe('replay')
        const result = await Promise.race([draining.then(() => 'done'), Bun.sleep(100).then(() => 'stuck')])
        expect(result).toBe('done')
    })

    it('counts the in-flight drain and newly queued bytes in one budget', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let cursor: string | undefined
        manager.subscribe({
            id: 'old', namespace: 'alpha', all: true,
            send: (_, id) => { cursor ??= id }, sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        manager.broadcast(event)
        manager.unsubscribe('old')
        manager.subscribe({
            id: 'replay', namespace: 'alpha', all: true, resumeFrom: cursor,
            send: () => new Promise<void>(() => {}), sendHeartbeat: () => {}
        })
        const large: SyncEvent = { ...event, data: { summary: 'x'.repeat(1_100_000) } as never }
        manager.broadcast(large)
        const draining = manager.drainPending('replay')
        manager.broadcast(large)
        await draining
        expect(manager.hasSubscription('replay')).toBe(false)
    })

    it('times out stalled writes and settles toast delivery', async () => {
        const tracker = new VisibilityTracker()
        const manager = new SSEManager(0, tracker, 20)
        let closed = 0
        manager.subscribe({
            id: 'stalled', namespace: 'alpha', all: true, visibility: 'visible',
            send: () => new Promise<void>(() => {}), sendHeartbeat: () => {}, close: () => { closed++ }
        })
        const delivered = await manager.sendToast('alpha', {
            type: 'toast', data: { title: 'Test', body: 'Body', sessionId: 's1', url: '/sessions/s1' }
        })
        expect(delivered).toBe(0)
        expect(closed).toBe(1)
        expect(manager.hasSubscription('stalled')).toBe(false)
        expect(tracker.isVisibleConnection('stalled')).toBe(false)
    })

    it('does not time out a connection that continues making progress', async () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 150)
        const resolvers: Array<() => void> = []
        manager.subscribe({
            id: 'progress', namespace: 'alpha', all: true,
            send: () => new Promise<void>(resolve => { resolvers.push(resolve) }), sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        manager.broadcast(event)
        await Bun.sleep(80)
        resolvers[0]!()
        await Bun.sleep(100)
        expect(manager.hasSubscription('progress')).toBe(true)
        resolvers[1]!()
        await Bun.sleep(160)
        expect(manager.hasSubscription('progress')).toBe(true)
        manager.stop()
    })

    it('times out a stalled heartbeat', async () => {
        const manager = new SSEManager(5, new VisibilityTracker(), 20)
        let closed = 0
        manager.subscribe({
            id: 'heartbeat', namespace: 'alpha', all: true,
            send: () => {}, sendHeartbeat: () => new Promise<void>(() => {}), close: () => { closed++ }
        })
        await Bun.sleep(70)
        expect(closed).toBe(1)
        expect(manager.hasSubscription('heartbeat')).toBe(false)
    })

    it('does not remove a replacement subscription when an old write fails', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        let reject!: (reason: Error) => void
        manager.subscribe({
            id: 'same', namespace: 'alpha', all: true,
            send: () => new Promise<void>((_, fail) => { reject = fail }), sendHeartbeat: () => {}
        })
        manager.broadcast(event)
        manager.subscribe({ id: 'same', namespace: 'alpha', all: true, send: () => {}, sendHeartbeat: () => {} })
        reject(new Error('old transport closed'))
        await Promise.resolve()
        expect(manager.hasSubscription('same')).toBe(true)
        manager.stop()
    })

    it('isolates synchronous send/close failures from other connections', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        manager.subscribe({
            id: 'broken', namespace: 'alpha', all: true,
            send: () => { throw new Error('write failed') }, sendHeartbeat: () => {},
            close: () => { throw new Error('close failed') }
        })
        let writes = 0
        manager.subscribe({
            id: 'healthy', namespace: 'alpha', all: true, send: () => { writes++ }, sendHeartbeat: () => {}
        })
        expect(() => manager.broadcast(event)).not.toThrow()
        expect(writes).toBe(1)
        expect(manager.hasSubscription('broken')).toBe(false)
        manager.stop()
    })
})
