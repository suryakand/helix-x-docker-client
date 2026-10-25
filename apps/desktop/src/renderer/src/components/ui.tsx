import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Loader2, X } from 'lucide-react'
import { api, cn } from '../lib/format'
import { useApp } from '../stores/app'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'secondary' && 'border border-border bg-panel hover:bg-panel-2',
        variant === 'ghost' && 'hover:bg-panel-2 text-fg',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

const fieldClass =
  'rounded-md border border-border bg-panel text-sm text-fg placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent disabled:opacity-60'

/** Full width unless the caller sets an explicit width (w-40 …), which would otherwise lose to w-full. */
function width(className?: string): string {
  return /(^|\s)w-/.test(className ?? '') ? '' : 'w-full'
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cn(fieldClass, width(className), 'h-9 px-3', className)} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cn(fieldClass, width(className), 'px-3 py-2 font-mono text-xs', className)}
    />
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(fieldClass, width(className), 'select h-9 pl-3', className)}>
      {children}
    </select>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-border'
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

export function Field({
  label,
  help,
  error,
  children,
  required
}: {
  label: string
  help?: ReactNode
  error?: string
  children: ReactNode
  required?: boolean
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-fg">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
      {error ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : help ? (
        <span className="block text-xs text-muted">{help}</span>
      ) : null}
    </label>
  )
}

export function Row({
  label,
  description,
  children
}: {
  label: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Card({
  title,
  actions,
  children,
  className
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="px-4 py-2">{children}</div>
    </section>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-panel-2 text-muted',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'accent' && 'bg-accent/15 text-accent',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div className="selectable rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
      {error instanceof Error ? error.message : String(error)}
    </div>
  )
}

export function Progress({
  value,
  total,
  indeterminate
}: {
  value: number
  total: number
  indeterminate?: boolean
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
      <div
        className={cn(
          'h-full rounded-full bg-accent transition-[width] duration-200',
          indeterminate && 'w-1/3 animate-pulse'
        )}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1200)
    return () => clearTimeout(t)
  }, [done])
  return (
    <Button
      size="sm"
      variant="ghost"
      title="Copy to clipboard"
      onClick={async () => {
        await api.app.copyText(text)
        setDone(true)
      }}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {label}
    </Button>
  )
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open modals, innermost last. Only the top one reacts to Escape / Tab (e.g. a help dialog over a form). */
const modalStack: string[] = []

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const id = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Focus management: move focus into the dialog, keep Tab inside it, restore focus on close.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    modalStack.push(id)
    const dialog = dialogRef.current
    const focusables = () =>
      [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null)
    if (dialog && !dialog.contains(document.activeElement)) {
      // Prefer the first form field; fall back to the dialog itself (the close button is a poor first stop).
      const first = focusables().find((el) => el.getAttribute('aria-label') !== 'Close')
      ;(first ?? dialog).focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        e.preventDefault()
        return
      }
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === firstEl || !dialog?.contains(active))) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (active === lastEl || !dialog?.contains(active))) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      modalStack.splice(modalStack.indexOf(id), 1)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, id])

  if (!open) return null
  // Window drag regions (page headers, the macOS title strip) are hit-tested by the OS, not by z-order, so a
  // tall dialog's close button sitting over a header would start a window drag instead of being clicked.
  // Electron subtracts no-drag areas that come *later* in the document, hence: a full-window no-drag
  // overlay, portalled to the end of <body> so it always follows every drag region.
  return createPortal(
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className={cn(
          'flex max-h-full w-full flex-col rounded-xl border border-border bg-panel shadow-2xl outline-none',
          wide ? 'max-w-3xl' : 'max-w-lg'
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 id={`${id}-title`} className="text-base font-semibold">
            {title}
          </h2>
          <button className="rounded p-1 text-muted hover:bg-panel-2" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body
  )
}

/** Global confirm dialog driven by the app store (see useConfirm). */
export function ConfirmHost() {
  const confirm = useApp((s) => s.confirm)
  const close = useApp((s) => s.closeConfirm)
  if (!confirm) return null
  return (
    <Modal
      open
      onClose={() => close(false)}
      title={confirm.title}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={confirm.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {confirm.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted">{confirm.message}</div>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-lg border bg-panel px-4 py-3 text-sm shadow-lg',
            t.tone === 'error' ? 'border-danger/40' : t.tone === 'success' ? 'border-ok/40' : 'border-border'
          )}
        >
          <div className="selectable min-w-0 flex-1 break-words">{t.message}</div>
          <button className="text-muted" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  onChange,
  items
}: {
  value: T
  onChange: (v: T) => void
  items: { value: T; label: ReactNode }[]
}) {
  return (
    <div className="flex gap-1 border-b border-border">
      {items.map((i) => (
        <button
          key={i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm',
            value === i.value
              ? 'border-accent text-fg font-medium'
              : 'border-transparent text-muted hover:text-fg'
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}
