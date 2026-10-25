import { app, BrowserWindow, session } from 'electron'
import log from 'electron-log/main'
import { AppContext, broadcast } from './context'
import { registerIpc } from './ipc/handlers'
import { buildMenu } from './menu'
import { createMainWindow } from './window'

// Isolated profile for automated tests / multiple profiles: HELIX_USER_DATA=/some/dir
if (process.env.HELIX_USER_DATA) app.setPath('userData', process.env.HELIX_USER_DATA)

log.initialize()
log.transports.file.maxSize = 5 * 1024 * 1024
// Never let credentials reach the log file.
log.hooks.push((message) => {
  message.data = message.data.map((d) =>
    typeof d === 'string' ? d.replace(/(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]') : d
  )
  return message
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let ctx: AppContext | undefined

  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('io.helixx.dockerclient')
    const prod = app.isPackaged || !process.env.ELECTRON_RENDERER_URL
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const csp = prod
        ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http://localhost:*; object-src 'none'"
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
    // The renderer never needs camera, notifications, etc.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    ctx = new AppContext()
    registerIpc(ctx)
    buildMenu(
      () => ctx?.lock('menu'),
      () => broadcast({ type: 'navigate', path: '/help' })
    )
    ctx.startAutoLock()
    log.info(`Starting ${app.getName()} ${app.getVersion()} on ${process.platform}/${process.arch}`)
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => ctx?.dispose())

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault())
  })
}
