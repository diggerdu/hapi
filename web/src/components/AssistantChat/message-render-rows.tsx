import { createContext, useContext } from 'react'
import type { ThreadMessage } from '@assistant-ui/react'
import { getConversationMessageAnchorId } from '@/chat/outline'

export type ThreadRenderRow = {
    key: string
    messageId: string
    anchorId: string
    partStart: number | null
    partEnd: number | null
    isLast: boolean
}

export const MessageRenderRowContext = createContext<ThreadRenderRow | null>(null)
export const useMessageRenderRow = () => useContext(MessageRenderRowContext)

export function buildThreadRenderRows(messages: readonly ThreadMessage[]): ThreadRenderRow[] {
    return messages.flatMap(message => {
        const anchorId = getConversationMessageAnchorId(message.id)
        const custom = message.metadata.custom as { kind?: string } | undefined
        if (message.role !== 'assistant' || message.content.length <= 1
            || custom?.kind === 'cli-output' || custom?.kind === 'codex-review') {
            return [{ key: message.id, messageId: message.id, anchorId, partStart: null, partEnd: null, isLast: true }]
        }
        const rows: ThreadRenderRow[] = []
        for (let start = 0; start < message.content.length; start++) {
            const part = message.content[start]!
            let end = start
            if (part.type === 'reasoning') {
                while (message.content[end + 1]?.type === 'reasoning') end++
            }
            const blockId = 'providerMetadata' in part ? part.providerMetadata?.hapi?.blockId : undefined
            const identity = part.type === 'tool-call' ? part.toolCallId
                : typeof blockId === 'string' ? blockId : `${part.type}:${start}`
            const key = `${message.id}:part:${identity}`
            rows.push({
                key,
                messageId: message.id,
                anchorId: start === 0 ? anchorId : `${anchorId}:part:${identity}`,
                partStart: start,
                partEnd: end,
                isLast: end === message.content.length - 1,
            })
            start = end
        }
        return rows
    })
}
