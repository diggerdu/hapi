export const MESSAGE_CACHE_MAX_ROWS = 200
export const MESSAGE_CACHE_MAX_CHARS = 256 * 1024
export const MESSAGE_CACHE_TOTAL_CHARS = 1024 * 1024

// Stop counting before a single tool result can dominate cache preparation.
function boundedSize(value: unknown, remaining: number): number {
    if (typeof value === 'string') return value.length + 2
    if (value === null || typeof value !== 'object') return 16
    let size = 2
    if (Array.isArray(value)) {
        for (const item of value) {
            size += 1 + boundedSize(item, remaining - size)
            if (size > remaining) break
        }
        return size
    }
    for (const [key, item] of Object.entries(value)) {
        size += key.length + 4 + boundedSize(item, remaining - size)
        if (size > remaining) return size
    }
    return size
}

export function selectCachedMessages<T>(messages: T[], isPending: (message: T) => boolean): T[] {
    const kept: T[] = []
    let budget = MESSAGE_CACHE_MAX_CHARS / 2
    // A contiguous suffix keeps the history cursor honest. Pending local rows
    // outside that suffix are retained separately and do not advance the cursor.
    let index = messages.length - 1
    for (; index >= 0 && kept.length < MESSAGE_CACHE_MAX_ROWS; index--) {
        const message = messages[index]!
        const size = boundedSize(message, budget)
        if (size > budget) break
        budget -= size
        kept.push(message)
    }
    kept.reverse()
    const pending = messages.slice(0, index + 1).filter(isPending)
    return pending.length ? [...pending, ...kept] : kept
}

export function createMessageWindowCache(storage: () => Storage | null, prefix: string) {
    let disabled = false
    const saved = new Map<string, string>()
    return {
        write(sessionId: string, value: unknown): void {
            if (disabled) return
            const target = storage()
            if (!target) return
            const key = prefix + sessionId
            if (boundedSize(value, MESSAGE_CACHE_MAX_CHARS / 2) > MESSAGE_CACHE_MAX_CHARS / 2) {
                try { target.removeItem(key) } catch { disabled = true }
                saved.delete(key)
                return
            }
            const serialized = JSON.stringify(value)
            if (serialized.length > MESSAGE_CACHE_MAX_CHARS) {
                target.removeItem(key)
                saved.delete(key)
                return
            }
            if (saved.get(key) === serialized) return
            try {
                let used = serialized.length
                const others: Array<{ key: string; length: number }> = []
                for (let i = 0; i < target.length; i++) {
                    const other = target.key(i)
                    if (!other?.startsWith(prefix) || other === key) continue
                    const length = target.getItem(other)?.length ?? 0
                    used += length
                    others.push({ key: other, length })
                }
                for (const other of others) {
                    if (used <= MESSAGE_CACHE_TOTAL_CHARS) break
                    target.removeItem(other.key)
                    saved.delete(other.key)
                    used -= other.length
                }
                target.setItem(key, serialized)
                saved.delete(key)
                saved.set(key, serialized)
            } catch {
                // Refresh recovery is best-effort. Never repeatedly block input
                // on a full or unavailable synchronous Storage backend.
                disabled = true
            }
        },
        delete(sessionId: string): void {
            const key = prefix + sessionId
            saved.delete(key)
            try { storage()?.removeItem(key) } catch { /* Storage may be blocked. */ }
        }
    }
}
