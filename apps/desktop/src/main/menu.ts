import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export function buildMenu(onLock: () => void, onHelp: () => void): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Lock', accelerator: 'Cmd+L', click: onLock },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        ...(isMac
          ? []
          : [
              { label: 'Lock', accelerator: 'Ctrl+L', click: onLock } as MenuItemConstructorOptions,
              { type: 'separator' } as MenuItemConstructorOptions
            ]),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        // Opens the built-in, offline documentation (bundled from docs/).
        { label: 'Helix-X Docker Client Help', accelerator: 'F1', click: onHelp },
        { label: 'Open Logs Folder', click: () => void shell.openPath(app.getPath('logs')) }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
