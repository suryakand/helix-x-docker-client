/// <reference lib="dom" /> // page.evaluate() callbacks run in the renderer
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from 'playwright/test'

test('first run: create vault, add a registry, lock and unlock', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'helix-e2e-'))
  // HELIX_E2E_EXECUTABLE=<path to packaged binary> runs the same test against a built package.
  const packaged = process.env.HELIX_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: packaged, args: [] }
      : { args: [resolve(__dirname, '../../out/main/index.js')] }),
    env: { ...process.env, HELIX_USER_DATA: userData, ELECTRON_RENDERER_URL: '' }
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Create a master password' })).toBeVisible()
    const pw = page.locator('input[type=password]')
    await pw.nth(0).fill('e2e-master-password')
    await pw.nth(1).fill('e2e-master-password')
    await page.getByRole('button', { name: 'Create vault' }).click()

    await expect(page.getByText('Connect a registry to start exploring')).toBeVisible()
    await page.getByRole('link', { name: 'Registries' }).click()
    await page.getByRole('button', { name: 'Add registry' }).first().click()
    // Regression: the dialog overlay must be a no-drag region placed after every drag region (page headers),
    // otherwise the OS swallows clicks on the close button where it overlaps a header.
    const overlay = await page.getByRole('dialog').evaluate((d) => {
      const o = d.parentElement!
      const style = getComputedStyle(o) as CSSStyleDeclaration & {
        webkitAppRegion?: string
        appRegion?: string
      }
      return {
        region: style.webkitAppRegion ?? style.appRegion,
        last: o === document.body.lastElementChild,
        afterHeaders: [...document.querySelectorAll('header')].every(
          (h) => o.contains(h) || !!(h.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING)
        )
      }
    })
    expect(overlay).toEqual({ region: 'no-drag', last: true, afterHeaders: true })
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Add registry' }).first().click()
    await page.getByPlaceholder('Production registry').fill('Local lab')
    await page.getByPlaceholder('https://registry.example.com:5000').fill('http://127.0.0.1:5999')
    await page.getByPlaceholder('user').fill('alice')
    await page.locator('input[type=password]').first().fill('top-secret')
    await page.getByRole('dialog').getByRole('button', { name: 'Add registry' }).click()
    await expect(page.getByRole('heading', { name: 'Local lab' })).toBeVisible()
    await expect(page.getByText('alice')).toBeVisible()

    await page.getByRole('link', { name: 'Preferences' }).click()
    await expect(page.getByText('Docker image storage')).toBeVisible()

    await page.getByRole('button', { name: /^Lock/ }).click()
    await expect(page.getByRole('heading', { name: 'Unlock Helix-X Docker Client' })).toBeVisible()
    await page.locator('input[type=password]').fill('wrong-password')
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByText('Incorrect master password')).toBeVisible()
    await page.locator('input[type=password]').fill('e2e-master-password')
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Registries' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
