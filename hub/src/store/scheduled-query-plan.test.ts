import { expect, it, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'

it('scheduled indicators scan the pending index, not consumed local history', () => {
    const store = new Store(':memory:')
    const db = (store as unknown as { db: Database }).db
    const session = store.sessions.getOrCreateSession('scheduled-plan', {}, null, 'owner')
    const other = store.sessions.getOrCreateSession('other', {}, null, 'elsewhere')
    const now = Date.now()
    for (let i = 0; i < 1000; i++) {
        store.messages.addMessage(session.id, { text: 'history' }, `history-${i}`)
        store.messages.markMessagesInvoked(session.id, [`history-${i}`], now)
    }
    store.messages.addMessage(session.id, { text: 'future' }, 'future', now + 60_000)
    store.messages.addMessage(session.id, { text: 'later' }, 'later', now + 120_000)
    store.messages.addMessage(session.id, { text: 'past' }, 'past', now - 1)
    store.messages.addMessage(session.id, { text: 'immediate' }, 'immediate')
    store.messages.addMessage(session.id, { text: 'uncertain' }, 'uncertain', now + 30_000)
    store.messages.markMessagesIndeterminate(session.id, ['uncertain'])
    store.messages.addMessage(other.id, { text: 'other' }, 'other', now + 1)
    const prepare = spyOn(db, 'prepare')
    try {
        expect(store.messages.countFutureScheduledLocalMessages(session.id, now)).toBe(2)
        expect([...store.messages.countFutureScheduledBySessionIds([session.id], now)])
            .toEqual([[session.id, 2]])
        expect([...store.messages.minFutureScheduledAtBySessionIds([session.id], now)])
            .toEqual([[session.id, now + 60_000]])
        expect(store.messages.countFutureScheduledBySessionIds([], now).size).toBe(0)
        expect(store.messages.minFutureScheduledAtBySessionIds([], now).size).toBe(0)
        const queries = prepare.mock.calls.map(call => String(call[0]))
        expect(queries).toHaveLength(3)
        for (const sql of queries) {
            const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(session.id, now) as { detail: string }[]
            expect(plan.some(row => row.detail.includes('idx_messages_uninvoked_local'))).toBe(true)
            expect(plan.some(row => row.detail.includes('idx_messages_local_id'))).toBe(false)
        }
    } finally {
        prepare.mockRestore()
        store.close()
    }
})
