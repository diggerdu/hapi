import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from './index'
import { SessionCache } from '../sync/sessionCache'
import type { EventPublisher } from '../sync/eventPublisher'

const stores: Store[] = []

function createStore(): Store {
    const store = new Store(':memory:')
    stores.push(store)
    return store
}

afterEach(() => {
    for (const store of stores.splice(0)) store.close()
})

describe('unchanged session synchronization', () => {
    it('acknowledges equivalent merged metadata without advancing version, activity or sequence', () => {
        const store = createStore()
        const metadata = { path: '/tmp', host: 'test', codexSessionId: 'thread', name: 'long session' }
        const session = store.sessions.getOrCreateSession('metadata', metadata, null, 'owner')
        const result = store.sessions.updateSessionMetadata(session.id,
            { name: 'long session', host: 'test', path: '/tmp' }, session.metadataVersion, 'owner',
            { skipUnchanged: true })

        expect(result).toEqual({ result: 'success', version: session.metadataVersion, value: metadata })
        expect(store.sessions.getSession(session.id)).toEqual(session)
    })

    it('rejects stale versions even when the payload is unchanged', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('stale', { name: 'same' }, { requests: {} }, 'owner')
        expect(store.sessions.updateSessionMetadata(session.id, session.metadata,
            session.metadataVersion + 1, 'owner', { skipUnchanged: true })).toMatchObject({ result: 'version-mismatch' })
        expect(store.sessions.updateSessionAgentState(session.id, session.agentState,
            session.agentStateVersion + 1, 'owner', { skipUnchanged: true })).toMatchObject({ result: 'version-mismatch' })
        expect(store.sessions.getSession(session.id)).toEqual(session)
    })

    it('advances changed metadata and state exactly once and preserves namespace isolation', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('changed', {}, null, 'owner')
        expect(store.sessions.updateSessionMetadata(session.id, { name: 'new' },
            session.metadataVersion, 'foreign', { skipUnchanged: true })).toEqual({ result: 'error' })
        expect(store.sessions.updateSessionAgentState(session.id, { requests: {} },
            session.agentStateVersion, 'foreign', { skipUnchanged: true })).toEqual({ result: 'error' })
        expect(store.sessions.updateSessionMetadata(session.id, { name: 'new' },
            session.metadataVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: session.metadataVersion + 1
        })
        expect(store.sessions.updateSessionAgentState(session.id, { requests: {} },
            session.agentStateVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: session.agentStateVersion + 1
        })
        const updated = store.sessions.getSession(session.id)!
        expect(store.sessions.updateSessionAgentState(session.id, { requests: {} },
            updated.agentStateVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: updated.agentStateVersion
        })
        expect(store.sessions.getSession(session.id)).toEqual(updated)
    })

    it('normalizes missing agent state to null without writing', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('null-state', {}, null, 'owner')
        expect(store.sessions.updateSessionAgentState(session.id, undefined,
            session.agentStateVersion, 'owner', { skipUnchanged: true })).toEqual({
            result: 'success', version: session.agentStateVersion, value: null
        })
        expect(store.sessions.getSession(session.id)).toEqual(session)
    })

    it('treats reordered nested state as unchanged but persists real nested changes', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('state-order', {},
            { requests: { first: { tool: 'read', status: 'pending' } }, completedRequests: {} }, 'owner')
        expect(store.sessions.updateSessionAgentState(session.id,
            { completedRequests: {}, requests: { first: { status: 'pending', tool: 'read' } } },
            session.agentStateVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: session.agentStateVersion
        })
        expect(store.sessions.updateSessionAgentState(session.id,
            { completedRequests: {}, requests: { first: { status: 'approved', tool: 'read' } } },
            session.agentStateVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: session.agentStateVersion + 1
        })
    })

    it('keeps explicit internal writes advancing versions unless deduplication is requested', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('internal-write', {}, null, 'owner')
        expect(store.sessions.updateSessionMetadata(session.id, session.metadata,
            session.metadataVersion, 'owner')).toMatchObject({ result: 'success', version: session.metadataVersion + 1 })
        expect(store.sessions.updateSessionAgentState(session.id, session.agentState,
            session.agentStateVersion, 'owner')).toMatchObject({ result: 'success', version: session.agentStateVersion + 1 })
    })

    it('still releases a preallocated stub when its metadata is unchanged', () => {
        const store = createStore()
        const identifier = crypto.randomUUID()
        const session = store.sessions.getOrCreateSession(`machine-spawn:${identifier}`,
            { path: '/tmp', host: 'test' }, null, 'owner', undefined, undefined, undefined, identifier)
        expect(store.sessions.updateSessionMetadata(session.id, session.metadata,
            session.metadataVersion, 'owner', { skipUnchanged: true })).toMatchObject({
            result: 'success', version: session.metadataVersion + 1
        })
        expect(store.sessions.getSession(session.id)?.tag).not.toBe(session.tag)
    })
})

describe('lightweight session activity', () => {
    it('persists monotonically and publishes without reading complete metadata', () => {
        const store = createStore()
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, { emit: (event: SyncEvent) => events.push(event) } as unknown as EventPublisher)
        const session = cache.getOrCreateSession('activity', { path: '/tmp', host: 'test' }, null, 'owner')
        events.length = 0
        const fullRead = spyOn(store.sessions, 'getSession')
        const timestamp = session.updatedAt + 1000
        cache.recordSessionActivity(session.id, timestamp)
        cache.recordSessionActivity(session.id, timestamp - 1)
        expect(fullRead).not.toHaveBeenCalled()
        expect(store.sessions.getSessionActivity(session.id)).toEqual({ namespace: 'owner', updatedAt: timestamp })
        expect(cache.getSession(session.id)?.updatedAt).toBe(timestamp)
        expect(events).toHaveLength(1)
        fullRead.mockRestore()
        store.sessions.deleteSession(session.id, 'owner')
        cache.recordSessionActivity(session.id, timestamp + 1)
        expect(events).toHaveLength(1)
        expect(store.sessions.getSessionActivity(session.id)).toBeNull()
    })
})

describe('immediate queue existence', () => {
    it('ignores scheduled, invoked and indeterminate rows and tracks removal', () => {
        const store = createStore()
        const session = store.sessions.getOrCreateSession('queue', {}, null, 'owner')
        store.messages.addMessage(session.id, { text: 'agent history' })
        store.messages.addMessage(session.id, { text: 'scheduled' }, 'scheduled', Date.now() + 10000)
        store.messages.addMessage(session.id, { text: 'invoked' }, 'invoked')
        store.messages.markMessagesInvoked(session.id, ['invoked'], Date.now())
        store.messages.addMessage(session.id, { text: 'uncertain' }, 'uncertain')
        store.messages.markMessagesIndeterminate(session.id, ['uncertain'])
        expect(store.messages.hasImmediateQueuedLocalMessages(session.id)).toBe(false)
        const queued = store.messages.addMessage(session.id, { text: 'queued' }, 'queued')
        expect(store.messages.hasImmediateQueuedLocalMessages(session.id)).toBe(true)
        expect(store.messages.hasImmediateQueuedLocalMessages('absent')).toBe(false)
        store.messages.cancelQueuedMessage(session.id, queued.id)
        expect(store.messages.hasImmediateQueuedLocalMessages(session.id)).toBe(false)
    })
})
