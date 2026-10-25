import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="drag flex min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-panel px-6 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
