import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { formatCompactToolTimestamp, ToolTimingSummary } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

describe('ToolTimingSummary', () => {
    it('preserves native local-time formatting without per-label locale setup', () => {
        const timestamps = [0, 1_700_000_000_000, Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1)]
        const expected = timestamps.map(value => new Date(value).toLocaleTimeString(undefined, {
            hour: 'numeric', minute: '2-digit', second: '2-digit'
        }))
        const native = vi.spyOn(Date.prototype, 'toLocaleTimeString')
        expect(timestamps.map(formatCompactToolTimestamp)).toEqual(expected)
        expect(native).not.toHaveBeenCalled()
        expect(formatCompactToolTimestamp(Number.NaN)).toBe('Invalid Date')
        native.mockRestore()
    })
    it('renders aligned label/value pairs for completed timing', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={1_700_000_002_500} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(screen.getByText('2.5s')).toBeInTheDocument()
    })

    it('omits finish while timing is still live', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={null} durationMs={2_500} />
            </I18nProvider>
        )

        expect(screen.getByText('Started')).toBeInTheDocument()
        expect(screen.queryByText('Finished')).not.toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
    })

    it('supports the compact UI typography used by grouped cards', () => {
        render(
            <I18nProvider>
                <ToolTimingSummary startedAt={1_700_000_000_000} completedAt={null} durationMs={2_500} typography="group" />
            </I18nProvider>
        )

        const summary = screen.getByText('Started').parentElement?.parentElement
        expect(summary).toHaveClass('text-xs', 'items-baseline')
        expect(summary).not.toHaveClass('items-center', 'font-sans', 'font-normal', 'leading-5')
        expect(summary).not.toHaveClass('font-mono')
    })
})
