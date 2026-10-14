import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test.describe(`long turn at ${viewport.width}px`, () => {
        test.use({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 })

        test('bounds mounted parts, retains expansion, follows new output and shares the complete turn', async ({ page }) => {
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto('/e2e-fixtures/history-load-fixture.html?virtualTest=1&longTurn=1')
            const thread = page.locator('.happy-thread-messages')
            await expect(thread).toHaveAttribute('data-hapi-virtual-part-count', '241')
            await expect(thread).toContainText('Part 237:')
            await page.waitForTimeout(2000)
            expect(await page.locator('[data-hapi-virtual-row]').count()).toBeLessThan(40)

            const reasoning = page.locator('[id$=":part:long-part-239"]').getByRole('button', { name: 'Reasoning', exact: true })
            await reasoning.click()
            await expect(reasoning).toHaveAttribute('aria-expanded', 'true')

            await page.getByRole('button', { name: 'Conversation outline', exact: true }).click()
            await page.getByRole('button', { name: /Inspect the complete long turn/ }).click()
            await expect(page.locator('[id="hapi-message-user-text:long-turn-prompt"]')).toBeInViewport()
            await expect.poll(() => page.locator('.chat-scroll-y').evaluate(element => element.scrollTop)).toBeLessThan(3)
            await page.locator('.chat-scroll-y').evaluate(element => element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }))
            await expect(reasoning).toBeInViewport()
            await expect(reasoning).toHaveAttribute('aria-expanded', 'true')
            await expect.poll(() => page.locator('.chat-scroll-y').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3)

            await page.evaluate(() => window.__probe.appendPart())
            await expect(thread).toContainText('Part 240:')
            await expect.poll(() => page.locator('.chat-scroll-y').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3)
            expect(await page.locator('[data-hapi-virtual-row]').count()).toBeLessThan(40)

            await page.locator('[id$=":part:long-part-240"]').hover()
            await page.locator('.happy-thread-messages [data-hapi-share-action="true"]').last().click()
            const preview = page.locator('.hapi-share-preview-root')
            await expect(preview).toContainText('Part 0:')
            await expect(preview).toContainText('Part 240:')
            await expect(preview).toContainText('Inspect the complete long turn')
            expect(errors).toEqual([])
        })
    })
}
