import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'

/** The app icon; electron-builder packs resources/icon.png into app.asar (and unpacks it). */
export const ICON_PATH = join(__dirname, '../../resources/icon.png')

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Helix-X Docker Client',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#f8fafc',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    // macOS takes the icon from the bundle (or app.dock.setIcon in dev, see index.ts).
    icon: isMac ? undefined : ICON_PATH,
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env.HELIX_DEVTOOLS === '1'
    }
  })

  win.once('ready-to-show', () => win.show())

  // Never open new windows or navigate away from the app; hand https links to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (!(dev && url.startsWith(dev))) e.preventDefault()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
