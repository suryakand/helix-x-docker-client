// Minimal i18n scaffold. Add a dictionary per language and select it in Preferences → Language.
const en = {
  'nav.explorer': 'Explorer',
  'nav.registries': 'Registries',
  'nav.local': 'Local Images',
  'nav.transfers': 'Transfers',
  'nav.settings': 'Settings',
  'nav.preferences': 'Preferences',
  'nav.help': 'Help',
  'login.title': 'Unlock Helix-X Docker Client',
  'login.subtitle': 'Enter your master password to decrypt your registry credentials.',
  'setup.title': 'Create a master password',
  'setup.subtitle':
    'Registry credentials are encrypted on this device with a key derived from this password. It cannot be recovered if you forget it.'
}

type Key = keyof typeof en
const dictionaries: Record<string, Partial<Record<Key, string>>> = { en }
let current = 'en'

export function setLanguage(lang: string): void {
  if (lang in dictionaries) current = lang
}

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  const template = dictionaries[current][key] ?? en[key]
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))
}
