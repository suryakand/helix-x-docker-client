// The application icon (same PNG electron-builder turns into .icns / .ico), so the in-app logo
// always matches the dock / taskbar icon.
import icon from '../../../../resources/icon.png'
import { cn } from '../lib/format'

export const APP_NAME = 'Helix-X Docker Client'

export function AppLogo({ className }: { className?: string }) {
  return (
    <img src={icon} alt="" aria-hidden draggable={false} className={cn('shrink-0 select-none', className)} />
  )
}
