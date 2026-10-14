import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'

export type OlderHistoryLoadResult = 'loaded' | 'transient-stop' | 'terminal-stop'

export type HappyChatContextValue = {
    cardState?: Map<string, unknown>
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    /** Hub-wide AGENT_NOTIFY_SUMMARY chat display; polled once at chat shell. */
    showSessionSummaryInChat: boolean
    disabled: boolean
    onRefresh: () => void
    codexPlanProposalId?: string | null
    onContinuePlan?: (planId: string) => void
    continuedPlanIds?: ReadonlySet<string>
    onRetryMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onShareTurn?: (
        messageElement: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
    ) => void
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    onNestedScrollFollowChange?: (followLatest: boolean) => void
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    const cards = useRef({ sessionId: props.value.sessionId, values: new Map<string, unknown>() })
    if (cards.current.sessionId !== props.value.sessionId) {
        cards.current = { sessionId: props.value.sessionId, values: new Map() }
    }
    // Keep dismissal outside virtualized cards so recycling cannot revive a menu.
    const [continued, setContinued] = useState<{ sessionId: string; ids: ReadonlySet<string> }>({
        sessionId: props.value.sessionId, ids: new Set()
    })
    const ids = continued.sessionId === props.value.sessionId ? continued.ids : new Set<string>()
    const value: HappyChatContextValue = {
        ...props.value,
        cardState: cards.current.values,
        continuedPlanIds: ids,
        onContinuePlan: props.value.onContinuePlan ? (planId) => {
            if (props.value.disabled || props.value.codexPlanProposalId !== planId || ids.has(planId)) return
            setContinued({ sessionId: props.value.sessionId, ids: new Set([...ids, planId]) })
            props.value.onContinuePlan?.(planId)
        } : undefined
    }
    return (
        <HappyChatContext.Provider value={value}>
            {props.children}
        </HappyChatContext.Provider>
    )
}

export function useChatCardState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
    const store = useOptionalHappyChatContext()?.cardState
    const [local, setLocal] = useState(() => ({ key, store, value: store?.has(key) ? store.get(key) as T : initial }))
    const value = local.key === key && local.store === store
        ? local.value : store?.has(key) ? store.get(key) as T : initial
    const latest = useRef(value)
    latest.current = value
    const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
        const next = typeof action === 'function' ? (action as (value: T) => T)(latest.current) : action
        latest.current = next
        store?.set(key, next)
        if (store && store.size > 2_000) store.delete(store.keys().next().value!)
        setLocal({ key, store, value: next })
    }, [key, store])
    return [value, update]
}

export function useOptionalHappyChatContext(): HappyChatContextValue | null {
    return useContext(HappyChatContext)
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useOptionalHappyChatContext()
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}
