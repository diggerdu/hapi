import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HappyChatProvider, useChatCardState, type HappyChatContextValue } from './context'

function Card({ id = 'one' }: { id?: string }) {
    const [open, setOpen] = useChatCardState(`group:${id}`, false)
    return <button aria-expanded={open} onClick={() => setOpen(value => !value)}>Group {id}</button>
}

describe('virtualized card state', () => {
    it('retains expansion through recycling and scopes it to the viewed session', () => {
        function Harness() {
            const [visible, show] = useState(true)
            const [sessionId, select] = useState('first')
            return <>
                <button onClick={() => show(value => !value)}>Recycle</button>
                <button onClick={() => select('second')}>Switch</button>
                <HappyChatProvider value={{ sessionId } as HappyChatContextValue}>{visible && <Card />}</HappyChatProvider>
            </>
        }
        render(<Harness />)
        fireEvent.click(screen.getByText('Group one'))
        expect(screen.getByText('Group one')).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(screen.getByText('Recycle'))
        fireEvent.click(screen.getByText('Recycle'))
        expect(screen.getByText('Group one')).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(screen.getByText('Switch'))
        expect(screen.getByText('Group one')).toHaveAttribute('aria-expanded', 'false')
    })
})
