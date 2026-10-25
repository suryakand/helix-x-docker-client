import { useMemo, type MouseEvent } from 'react'
import { api, cn } from '../lib/format'
import { HELP_DOCS, renderMarkdown } from '../lib/docs'

/**
 * Renders bundled Markdown documentation. Links to other docs (`registries.md#…`) call `onOpenDoc`,
 * in-page anchors scroll, and https links open in the system browser.
 */
export function DocView({
  markdown,
  onOpenDoc,
  className
}: {
  markdown: string
  onOpenDoc?: (doc: string, section?: string) => void
  className?: string
}) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown])

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a')
    const href = link?.getAttribute('href')
    if (!href) return
    e.preventDefault()
    if (/^https:\/\//i.test(href)) {
      void api.app.openExternal(href)
      return
    }
    if (href.startsWith('#')) {
      document
        .getElementById(decodeURIComponent(href.slice(1)))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const m = /(?:^|\/)([\w-]+)\.md(?:#(.+))?$/.exec(href)
    if (m && HELP_DOCS.some((d) => d.id === m[1])) onOpenDoc?.(m[1], m[2])
  }

  return (
    <div
      className={cn(
        'selectable prose prose-sm max-w-none dark:prose-invert prose-headings:scroll-mt-4 prose-a:text-accent prose-code:before:content-none prose-code:after:content-none prose-table:text-xs',
        className
      )}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
