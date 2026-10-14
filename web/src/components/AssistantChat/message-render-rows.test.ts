import { describe, expect, it } from 'vitest'
import { fromThreadMessageLike } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { buildThreadRenderRows } from './message-render-rows'

const assistant = (content: ThreadMessageLike['content']) => fromThreadMessageLike(
    { id: 'assistant', role: 'assistant', content }, 'assistant', { type: 'complete', reason: 'stop' }
)

describe('thread render rows', () => {
    it('splits a single long turn without duplicating actions or losing parts', () => {
        const message = assistant(Array.from({ length: 100 }, (_, index) => ({
            type: 'tool-call' as const, toolCallId: `tool-${index}`, toolName: 'Read', args: {},
        })))
        const rows = buildThreadRenderRows([message])
        expect(rows).toHaveLength(100)
        expect(new Set(rows.map(row => row.key)).size).toBe(100)
        expect(rows.filter(row => row.isLast)).toHaveLength(1)
        expect(rows[0]!.anchorId).toBe('hapi-message-assistant')
        expect(rows.flatMap(row => Array.from({ length: row.partEnd! - row.partStart! + 1 }, (_, index) => row.partStart! + index)))
            .toEqual(Array.from({ length: 100 }, (_, index) => index))
    })

    it('keeps consecutive reasoning together and stable block keys through prepends', () => {
        const content = [
            { type: 'reasoning' as const, text: 'first', providerMetadata: { hapi: { blockId: 'reasoning' } } },
            { type: 'reasoning' as const, text: 'second' },
            { type: 'text' as const, text: 'answer', providerMetadata: { hapi: { blockId: 'answer' } } },
        ]
        const original = buildThreadRenderRows([assistant(content)])
        const prepended = buildThreadRenderRows([assistant([{ type: 'text', text: 'older' }, ...content])])
        expect(original).toHaveLength(2)
        expect(original[0]).toMatchObject({ partStart: 0, partEnd: 1 })
        expect(prepended.slice(1).map(row => row.key)).toEqual(original.map(row => row.key))
    })

    it('keeps empty and special assistant presentations intact', () => {
        const empty = assistant([])
        const special = fromThreadMessageLike(
            { id: 'cli', role: 'assistant', content: 'output', metadata: { custom: { kind: 'cli-output' } } },
            'cli', { type: 'complete', reason: 'stop' }
        )
        expect(buildThreadRenderRows([empty, special]).map(row => row.partStart)).toEqual([null, null])
    })
})
