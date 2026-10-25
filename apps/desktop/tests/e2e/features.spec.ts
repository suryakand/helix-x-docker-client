/// <reference lib="dom" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from 'playwright/test'

async function launch(
  env: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page; cleanup: () => Promise<void> }> {
  const userData = mkdtempSync(join(tmpdir(), 'helix-e2e-'))
  const packaged = process.env.HELIX_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(packaged
      ? { executablePath: packaged, args: [] }
      : { args: [resolve(__dirname, '../../out/main/index.js')] }),
    env: { ...process.env, HELIX_USER_DATA: userData, ELECTRON_RENDERER_URL: '', ...env }
  })
  const page = await app.firstWindow()
  const pw = page.locator('input[type=password]')
  await pw.nth(0).fill('e2e-master-password')
  await pw.nth(1).fill('e2e-master-password')
  await page.getByRole('button', { name: 'Create vault' }).click()
  await expect(page.getByRole('link', { name: 'Registries' })).toBeVisible()
  return {
    app,
    page,
    cleanup: async () => {
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    }
  }
}

test('built-in Help and per-provider setup guide', async () => {
  const { page, cleanup } = await launch()
  try {
    await page.getByRole('link', { name: 'Help' }).click()
    await expect(page.getByRole('heading', { name: 'User guide', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Registry setup' }).click()
    await expect(page.getByRole('heading', { name: 'Amazon ECR', level: 2 })).toBeVisible()

    // Setup guide opens on top of the form and keeps what was typed.
    await page.getByRole('link', { name: 'Registries' }).click()
    await page.getByRole('button', { name: 'Add registry' }).first().click()
    await page.getByRole('button', { name: 'Docker Hub', exact: true }).click()
    await page.getByPlaceholder('myorg').fill('acme')
    await page.getByRole('button', { name: 'Setup guide' }).click()
    const guide = page.getByRole('dialog', { name: /Setup guide — Docker Hub/ })
    await expect(guide.getByText('Personal Access Token').first()).toBeVisible()
    await guide.getByRole('button', { name: 'Back to form' }).click()
    await expect(guide).toHaveCount(0)
    await expect(page.getByPlaceholder('myorg')).toHaveValue('acme')
  } finally {
    await cleanup()
  }
})

test('modal keyboard handling: focus trap, stacked Escape, focus restore', async () => {
  const { page, cleanup } = await launch()
  try {
    await page.getByRole('link', { name: 'Registries' }).click()
    const opener = page.getByRole('button', { name: 'Add registry' }).first()
    await opener.click()
    const form = page.getByRole('dialog', { name: 'Add registry' })
    await expect(form).toBeVisible()
    const insideDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))
    expect(await insideDialog()).toBe(true)
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      expect(await insideDialog()).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await insideDialog()).toBe(true)
    }

    // Escape closes only the top-most dialog.
    await form.getByRole('button', { name: 'Setup guide' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
  } finally {
    await cleanup()
  }
})

test('import docker logins from config.json', async () => {
  const dockerConfig = mkdtempSync(join(tmpdir(), 'docker-config-'))
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  writeFileSync(
    join(dockerConfig, 'config.json'),
    JSON.stringify({
      auths: {
        'registry.fixture.test:5000': { auth: b64('fixture-user:fixture-pass') },
        '123456789012.dkr.ecr.us-east-1.amazonaws.com': { auth: b64('AWS:short-lived') }
      }
    })
  )
  const { page, cleanup } = await launch({ DOCKER_CONFIG: dockerConfig })
  try {
    await page.getByRole('link', { name: 'Registries' }).click()
    await page.getByRole('button', { name: 'Import docker logins' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Import docker logins' })
    await expect(dialog.getByText('registry.fixture.test:5000')).toBeVisible()
    await expect(dialog.getByText('not importable')).toBeVisible()
    await expect(dialog.getByLabel('Import 123456789012.dkr.ecr.us-east-1.amazonaws.com')).toBeDisabled()
    await dialog.getByRole('button', { name: /^Import 1$/ }).click()
    await expect(page.getByRole('heading', { name: 'registry.fixture.test:5000' })).toBeVisible()
    await expect(page.getByText('fixture-user')).toBeVisible()

    // Importing again finds it already added.
    await page.getByRole('button', { name: 'Import docker logins' }).first().click()
    await expect(page.getByRole('dialog').getByText('already added')).toBeVisible()
  } finally {
    await cleanup()
    rmSync(dockerConfig, { recursive: true, force: true })
  }
})
