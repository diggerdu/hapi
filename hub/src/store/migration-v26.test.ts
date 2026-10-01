import { afterEach, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('migrates v26 queue lookups to a partial index without losing any queue states', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-v26-'))
    directories.push(directory)
    const path = join(directory, 'hapi.db')
    const store = new Store(path)
    const session = store.sessions.getOrCreateSession('queue', {}, null, 'owner')
    store.messages.addMessage(session.id, { text: 'immediate' }, 'immediate')
    store.messages.addMessage(session.id, { text: 'future' }, 'future', Date.now() + 60000)
    store.messages.addMessage(session.id, { text: 'uncertain' }, 'uncertain')
    store.messages.markMessagesIndeterminate(session.id, ['uncertain'])
    store.messages.addMessage(session.id, { text: 'invoked' }, 'invoked')
    store.messages.markMessagesInvoked(session.id, ['invoked'], Date.now())
    store.close()
    const legacy = new Database(path)
    legacy.exec('DROP INDEX idx_messages_uninvoked_local; PRAGMA user_version = 26;')
    legacy.close()
    const migrated = new Store(path)
    try {
        const db = (migrated as unknown as { db: Database }).db
        expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 27 })
        const plan = db.query(`EXPLAIN QUERY PLAN SELECT * FROM messages
            WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL ORDER BY seq ASC`
        ).all(session.id) as Array<{ detail: string }>
        expect(plan.some(row => row.detail.includes('idx_messages_uninvoked_local'))).toBe(true)
        expect(migrated.messages.getUninvokedLocalMessages(session.id).map(row => row.localId))
            .toEqual(['immediate', 'future', 'uncertain'])
        expect(migrated.messages.countMessages(session.id)).toBe(4)
    } finally { migrated.close() }
    new Store(path).close()
})
