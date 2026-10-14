import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMessageWindowCache, MESSAGE_CACHE_MAX_CHARS, MESSAGE_CACHE_MAX_ROWS, MESSAGE_CACHE_TOTAL_CHARS, selectCachedMessages } from './message-window-cache'

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })

describe('bounded message-window cache', () => {
    it('retains a contiguous recent suffix plus pending local rows', () => {
        const messages = Array.from({ length: 500 }, (_, id) => ({ id, pending: id === 1 }))
        const selected = selectCachedMessages(messages, message => message.pending)
        expect(selected).toHaveLength(MESSAGE_CACHE_MAX_ROWS + 1)
        expect(selected[0]).toBe(messages[1])
        expect(selected.slice(1)).toEqual(messages.slice(-MESSAGE_CACHE_MAX_ROWS))
    })

    it('does not serialize a huge tool payload to select a cache suffix', () => {
        const huge = { text: 'x'.repeat(10_000_000) }
        const stringify = vi.spyOn(JSON, 'stringify')
        expect(selectCachedMessages([huge, { text: 'recent' }], () => false)).toEqual([{ text: 'recent' }])
        expect(stringify).not.toHaveBeenCalled()
    })

    it('skips identical writes and enforces a budget across same-origin session keys', () => {
        const cache = createMessageWindowCache(() => sessionStorage, 'window:')
        const setItem = vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem')
        sessionStorage.setItem('unrelated', 'keep')
        const payload = { text: 'x'.repeat(MESSAGE_CACHE_MAX_CHARS / 2 - 100) }
        for (let i = 0; i < 16; i++) cache.write(String(i), payload)
        const calls = setItem.mock.calls.length
        cache.write('15', payload)
        expect(setItem).toHaveBeenCalledTimes(calls)
        const keys = Object.keys(sessionStorage).filter(key => key.startsWith('window:'))
        const total = keys.reduce((sum, key) => sum + sessionStorage.getItem(key)!.length, 0)
        expect(total).toBeLessThanOrEqual(MESSAGE_CACHE_TOTAL_CHARS)
        expect(sessionStorage.getItem('window:0')).toBeNull()
        expect(sessionStorage.getItem('unrelated')).toBe('keep')
    })

    it('opens the circuit after quota failure without retrying serialization or writes', () => {
        const setItem = vi.fn(() => { throw new DOMException('full', 'QuotaExceededError') })
        const target = { length: 0, setItem } as unknown as Storage
        const cache = createMessageWindowCache(() => target, 'window:')
        cache.write('one', { text: 'first' })
        const stringify = vi.spyOn(JSON, 'stringify')
        cache.write('one', { text: 'changed' })
        cache.write('two', { text: 'another session' })
        expect(setItem).toHaveBeenCalledTimes(1)
        expect(stringify).not.toHaveBeenCalled()
    })

    it('never writes oversized snapshots and can save again after explicit deletion', () => {
        const cache = createMessageWindowCache(() => sessionStorage, 'window:')
        cache.write('one', { text: 'small' })
        cache.write('one', { text: 'x'.repeat(MESSAGE_CACHE_MAX_CHARS) })
        expect(sessionStorage.getItem('window:one')).toBeNull()
        cache.write('one', { text: 'small' })
        cache.delete('one')
        cache.write('one', { text: 'small' })
        expect(JSON.parse(sessionStorage.getItem('window:one')!)).toEqual({ text: 'small' })
    })

    it('does not stringify oversized pending payloads', () => {
        const cache = createMessageWindowCache(() => sessionStorage, 'window:')
        const stringify = vi.spyOn(JSON, 'stringify')
        cache.write('one', { messages: [{ text: 'x'.repeat(10_000_000), status: 'queued' }] })
        expect(stringify).not.toHaveBeenCalled()
        expect(sessionStorage.getItem('window:one')).toBeNull()
    })
})
