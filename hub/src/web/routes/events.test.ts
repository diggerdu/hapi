import { describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'

function createApp() {
    const tracker = new VisibilityTracker()
    const manager = new SSEManager(0, tracker)
    const subscriptions = spyOn(manager, 'subscribe')
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'alpha')
        await next()
    })
    app.route('/', createEventsRoutes(() => manager, () => null, () => tracker))
    return { app, manager, subscriptions }
}

async function readEvent(reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>) {
    const { done, value } = await reader.read()
    expect(done).toBe(false)
    const frame = new TextDecoder().decode(value)
    const data = frame.split('\n').find(line => line.startsWith('data: '))!
    return { data: JSON.parse(data.slice(6)), id: frame.split('\n').find(line => line.startsWith('id: '))?.slice(4) }
}

describe('SSE events route lifecycle', () => {
    it('does not register an already-aborted request', async () => {
        const { app, manager, subscriptions } = createApp()
        const controller = new AbortController()
        controller.abort()
        const response = await app.request(new Request('http://localhost/events?all=1', { signal: controller.signal }))
        expect(subscriptions).not.toHaveBeenCalled()
        await response.body!.cancel()
        manager.stop()
    })

    it('cleans up a request aborted before the handshake is consumed', async () => {
        const { app, manager, subscriptions } = createApp()
        const controller = new AbortController()
        const response = await app.request(new Request('http://localhost/events?all=1', { signal: controller.signal }))
        const id = subscriptions.mock.calls[0]![0].id
        controller.abort()
        await Bun.sleep(10)
        expect(manager.hasSubscription(id)).toBe(false)
        await response.body!.cancel()
        manager.stop()
    })

    it('cleans up when the response is canceled during replay', async () => {
        const { app, manager, subscriptions } = createApp()
        let cursor: string | undefined
        manager.subscribe({
            id: 'old', namespace: 'alpha', all: true,
            send: (_, id) => { cursor ??= id }, sendHeartbeat: () => {}
        })
        for (let i = 0; i < 10; i++) {
            manager.broadcast({ type: 'session-updated', sessionId: `s${i}`, namespace: 'alpha' })
        }
        manager.unsubscribe('old')
        const response = await app.request(`/events?all=1&lastEventId=${cursor}`)
        const id = subscriptions.mock.calls.at(-1)![0].id
        await response.body!.cancel()
        await Bun.sleep(10)
        expect(manager.hasSubscription(id)).toBe(false)
        manager.stop()
    })

    it('delivers the verdict, replay and live events in cursor order', async () => {
        const { app, manager } = createApp()
        let cursor: string | undefined
        manager.subscribe({
            id: 'old', namespace: 'alpha', all: true,
            send: (_, id) => { cursor ??= id }, sendHeartbeat: () => {}
        })
        for (let i = 0; i < 3; i++) {
            manager.broadcast({ type: 'session-updated', sessionId: `s${i}`, namespace: 'alpha' })
        }
        manager.unsubscribe('old')
        const response = await app.request(`/events?all=1&lastEventId=${cursor}`)
        const reader = response.body!.getReader()
        const handshake = await readEvent(reader)
        expect(handshake.data.data.resume).toBe('ok')
        expect((await readEvent(reader)).data.sessionId).toBe('s1')
        expect((await readEvent(reader)).data.sessionId).toBe('s2')
        manager.broadcast({ type: 'session-updated', sessionId: 's3', namespace: 'alpha' })
        const live = await readEvent(reader)
        expect(live.data.sessionId).toBe('s3')
        expect(live.id!.split(':')[1]).toBe('4')
        await reader.cancel()
        manager.stop()
    })

    it('keeps a reading client live while disconnecting a stalled client', async () => {
        const { app, manager } = createApp()
        const slow = (await app.request('/events?all=1')).body!.getReader()
        const slowId = (await readEvent(slow)).data.data.subscriptionId
        const fast = (await app.request('/events?all=1')).body!.getReader()
        const fastId = (await readEvent(fast)).data.data.subscriptionId
        for (let i = 0; i < 300; i++) {
            manager.broadcast({ type: 'session-updated', sessionId: `s${i}`, namespace: 'alpha' })
            expect((await readEvent(fast)).data.sessionId).toBe(`s${i}`)
        }
        expect(manager.hasSubscription(slowId)).toBe(false)
        expect(manager.hasSubscription(fastId)).toBe(true)
        await slow.cancel()
        await fast.cancel()
        manager.stop()
    })

    it('cleans up a gzip connection when its reader cancels', async () => {
        const { app, manager, subscriptions } = createApp()
        const response = await app.request('/events?all=1', { headers: { 'Accept-Encoding': 'gzip' } })
        expect(response.headers.get('Content-Encoding')).toBe('gzip')
        const reader = response.body!.getReader()
        await reader.read()
        const id = subscriptions.mock.calls[0]![0].id
        await reader.cancel()
        await Bun.sleep(10)
        expect(manager.hasSubscription(id)).toBe(false)
        manager.stop()
    })

    it('requires REST resync when a disconnected client has missed the replay window', async () => {
        const { app, manager } = createApp()
        const reader = (await app.request('/events?all=1')).body!.getReader()
        await readEvent(reader)
        manager.broadcast({ type: 'session-updated', sessionId: 'first', namespace: 'alpha' })
        const cursor = (await readEvent(reader)).id!
        for (let i = 0; i < 600; i++) {
            manager.broadcast({ type: 'session-updated', sessionId: `s${i}`, namespace: 'alpha' })
        }
        const resumed = await app.request('/events?all=1', { headers: { 'Last-Event-ID': cursor } })
        const resumedReader = resumed.body!.getReader()
        expect((await readEvent(resumedReader)).data.data.resume).toBe('gap')
        await reader.cancel()
        await resumedReader.cancel()
        manager.stop()
    })
})
