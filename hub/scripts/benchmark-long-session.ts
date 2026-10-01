import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import type { EventPublisher } from '../src/sync/eventPublisher'
import { SessionCache } from '../src/sync/sessionCache'

const iterations = 1000
const directory = mkdtempSync(join(tmpdir(), 'hapi-long-session-'))

function measure(operation: () => void): { p50Ms: number; p95Ms: number; totalMs: number } {
    for (let index = 0; index < 50; index++) operation()
    const timings: number[] = []
    for (let index = 0; index < iterations; index++) {
        const start = performance.now()
        operation()
        timings.push(performance.now() - start)
    }
    timings.sort((left, right) => left - right)
    return {
        p50Ms: timings[Math.floor(timings.length * 0.5)],
        p95Ms: timings[Math.floor(timings.length * 0.95)],
        totalMs: timings.reduce((total, duration) => total + duration, 0)
    }
}

try {
    for (const messageCount of [10000, 100000, 500000]) {
        const dbPath = join(directory, `${messageCount}.db`)
        const store = new Store(dbPath)
        const fixtureDb = new Database(dbPath)
        try {
            const metadata = {
                path: '/tmp/benchmark', host: 'benchmark',
                history: Array.from({ length: Math.floor(messageCount / 100) }, (_, index) => ({
                    id: `turn-${index}`, position: index * 100, summary: 'Synthetic conversation history'
                }))
            }
            const state = { requests: {}, completedRequests: {} }
            const session = store.sessions.getOrCreateSession('benchmark', metadata, state, 'benchmark')
            fixtureDb.query(`
                WITH RECURSIVE sequence(value) AS (
                    SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
                )
                INSERT INTO messages (id, session_id, content, created_at, seq, invoked_at, local_id)
                SELECT 'history-' || value, ?, '{"role":"agent","content":{"text":"history"}}',
                    ?, value, ?, 'local-' || value FROM sequence
            `).run(messageCount, session.id, session.createdAt, session.createdAt)
            const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
            cache.refreshSession(session.id)
            let timestamp = session.updatedAt
            let metadataVersion = session.metadataVersion
            let stateVersion = session.agentStateVersion
            const measured = {
                activity: measure(() => cache.recordSessionActivity(session.id, ++timestamp)),
                metadataReplay: measure(() => {
                    const result = store.sessions.updateSessionMetadata(session.id, metadata, metadataVersion,
                        'benchmark', { skipUnchanged: true })
                    if (result.result !== 'success') throw new Error('Metadata replay failed')
                    metadataVersion = result.version
                }),
                stateReplay: measure(() => {
                    const result = store.sessions.updateSessionAgentState(session.id, state, stateVersion,
                        'benchmark', { skipUnchanged: true })
                    if (result.result !== 'success') throw new Error('State replay failed')
                    stateVersion = result.version
                }),
                emptyQueue: measure(() => {
                    if (typeof store.messages.hasImmediateQueuedLocalMessages === 'function') {
                        store.messages.hasImmediateQueuedLocalMessages(session.id)
                    } else {
                        store.messages.getImmediateQueuedLocalMessages(session.id)
                    }
                })
            }
            const queueQueryPlan = fixtureDb.query(`
                EXPLAIN QUERY PLAN SELECT 1 FROM messages
                WHERE session_id = ? AND invoked_at IS NULL AND local_id IS NOT NULL
                  AND scheduled_at IS NULL AND delivery_state = 'queued' ORDER BY seq ASC LIMIT 1
            `).all(session.id)
            console.log(JSON.stringify({ messageCount, iterations, metadataBytes: JSON.stringify(metadata).length,
                measured, metadataVersionDelta: metadataVersion - session.metadataVersion,
                stateVersionDelta: stateVersion - session.agentStateVersion, queueQueryPlan }))
        } finally {
            fixtureDb.close()
            store.close()
        }
    }
} finally {
    rmSync(directory, { recursive: true, force: true })
}
