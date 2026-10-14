import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { buildThreadRenderRows, MessageRenderRowContext } from './message-render-rows'

type MessageComponents = ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']

export type VirtualThreadHandle = {
    reveal: (messageId: string) => Promise<HTMLElement | null>
    withTurn: (anchorId: string, capture: () => void) => Promise<void>
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

export const VIRTUAL_THREAD_MESSAGE_THRESHOLD = 8
export const VIRTUAL_THREAD_PART_THRESHOLD = 32

export function shouldVirtualizeThreadMessages(messageCount: number, partCount: number): boolean {
    return messageCount > VIRTUAL_THREAD_MESSAGE_THRESHOLD || partCount > VIRTUAL_THREAD_PART_THRESHOLD
}

export function estimateVirtualThreadMessageSize(partCount: number): number {
    if (partCount <= 1) return 96
    return Math.min(1200, 96 + partCount * 96)
}

export const VirtualThreadMessages = memo(forwardRef<VirtualThreadHandle, {
    components: MessageComponents
    scrollElement: HTMLDivElement | null
    getPinnedAnchorId: () => string | null
}>(function VirtualThreadMessages({ components, scrollElement, getPinnedAnchorId }, ref) {
    const messages = useAuiState(state => state.thread.messages)
    const ids = useMemo(() => messages.map(message => message.id), [messages])
    const rows = useMemo(() => buildThreadRenderRows(messages), [messages])
    const containerRef = useRef<HTMLDivElement>(null)
    const mounted = useRef(true)
    const [pinned, setPinned] = useState<string[]>([])
    const totalPartCount = messages.reduce((total, message) => total + message.content.length, 0)
    const virtual = shouldVirtualizeThreadMessages(ids.length, totalPartCount)
    const [scrollMargin, setScrollMargin] = useState(13)
    const key = useCallback((index: number) => rows[index]!.key, [rows])
    const estimateSize = useCallback(
        () => estimateVirtualThreadMessageSize(1),
        []
    )
    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
        const indexes = new Set(defaultRangeExtractor(range))
        const anchor = getPinnedAnchorId()
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index]!
            if (row.anchorId === anchor || pinned.includes(row.messageId)) indexes.add(index)
        }
        return [...indexes].sort((a, b) => a - b)
    }, [rows, pinned, getPinnedAnchorId])
    const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        enabled: virtual,
        count: virtual ? rows.length : 0,
        getScrollElement: () => scrollElement,
        getItemKey: key,
        estimateSize,
        overscan: 2,
        gap: 0,
        rangeExtractor,
        scrollMargin,
        useAnimationFrameWithResizeObserver: true,
        measureElement: (element, entry) => entry?.borderBoxSize?.[0]?.blockSize
            ?? (entry ? entry.contentRect.height + Number(element.dataset.rowPadding ?? 0)
                : Number(element.dataset.estimatedSize ?? 96)),
    })
    useLayoutEffect(() => {
        const container = containerRef.current
        if (!virtual || !container || !scrollElement) return
        const measureMargin = () => setScrollMargin(container.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop)
        measureMargin()
        const observer = new ResizeObserver(measureMargin)
        if (container.parentElement) observer.observe(container.parentElement)
        return () => observer.disconnect()
    }, [scrollElement, virtual])
    useLayoutEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    useImperativeHandle(ref, () => ({
        async reveal(messageId) {
            const index = rows.findIndex(row => row.messageId === messageId)
            if (index < 0) return null
            if (virtual) {
                setPinned([messageId])
                const offset = list.getOffsetForIndex(index, 'start')?.[0]
                if (offset !== undefined) list.scrollToOffset(offset)
            }
            await nextFrame()
            await nextFrame()
            if (!mounted.current) return null
            const element = document.getElementById(getConversationMessageAnchorId(messageId))
            setPinned([])
            return element
        },
        async withTurn(anchorId, capture) {
            const target = rows.find(row => row.anchorId === anchorId)
            let start = ids.indexOf(target?.messageId ?? '')
            if (start < 0 || !virtual) { capture(); return }
            while (start > 0 && messages[start]?.role !== 'user') start--
            let end = start + 1
            while (end < ids.length && messages[end]?.role !== 'user') end++
            setPinned(ids.slice(start, end))
            try {
                await nextFrame()
                await nextFrame()
                if (mounted.current) capture()
            } finally {
                if (mounted.current) setPinned([])
            }
        }
    }), [ids, rows, messages, virtual, list])

    if (!virtual) {
        return <div className="happy-thread-messages flex flex-col gap-3" ref={containerRef}>
            {ids.map(messageId => <ThreadPrimitive.Unstable_MessageById key={messageId} messageId={messageId} components={components} />)}
        </div>
    }
    return (
        <div ref={containerRef} className="happy-thread-messages relative" data-virtualized="true"
            data-hapi-virtual-message-count={ids.length}
            data-hapi-virtual-part-count={totalPartCount}
            style={{ height: list.getTotalSize(), overflowAnchor: 'none' }}>
            {list.getVirtualItems().map(item => (
                <div key={item.key} data-index={item.index} data-hapi-virtual-row="true"
                    data-estimated-size={item.size} data-row-padding={rows[item.index]!.isLast ? 12 : 0} ref={list.measureElement}
                    style={{ position: 'absolute', top: item.start - list.options.scrollMargin, left: 0, width: '100%', paddingBottom: rows[item.index]!.isLast ? 12 : 0 }}>
                    <MessageRenderRowContext.Provider value={rows[item.index]!}>
                        <ThreadPrimitive.Unstable_MessageById messageId={rows[item.index]!.messageId} components={components} />
                    </MessageRenderRowContext.Provider>
                </div>
            ))}
        </div>
    )
}))
