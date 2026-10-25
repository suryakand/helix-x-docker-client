import { useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { BookOpen } from 'lucide-react'
import { DocView } from '../components/DocView'
import { PageHeader } from '../components/PageHeader'
import { getDoc, headings, HELP_DOCS } from '../lib/docs'
import { cn } from '../lib/format'

export function HelpPage() {
  const [params, setParams] = useSearchParams()
  const doc = getDoc(params.get('doc'))
  const section = params.get('section') ?? undefined
  const toc = useMemo(() => headings(doc.markdown), [doc])
  const scroller = useRef<HTMLDivElement>(null)

  const open = (id: string, sectionId?: string) => {
    const p = new URLSearchParams({ doc: id })
    if (sectionId) p.set('section', sectionId)
    setParams(p)
  }

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView({ block: 'start' })
    else scroller.current?.scrollTo({ top: 0 })
  }, [doc.id, section])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Help"
        subtitle="Documentation for this version of Helix-X Docker Client, available offline."
      />
      <div className="flex min-h-0 flex-1">
        <nav className="w-60 shrink-0 overflow-auto border-r border-border bg-panel p-3">
          <ul className="space-y-0.5">
            {HELP_DOCS.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => open(d.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm',
                    d.id === doc.id ? 'bg-accent/10 font-medium text-accent' : 'hover:bg-panel-2'
                  )}
                >
                  <BookOpen className="size-4 shrink-0" />
                  {d.title}
                </button>
                {d.id === doc.id && toc.length > 0 && (
                  <ul className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-border pl-2">
                    {toc.map((h) => (
                      <li key={h.id}>
                        <button
                          onClick={() => open(d.id, h.id)}
                          className={cn(
                            'block w-full truncate rounded px-2 py-1 text-left text-xs',
                            section === h.id ? 'text-accent' : 'text-muted hover:text-fg'
                          )}
                          title={h.text}
                        >
                          {h.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-6">
          <DocView markdown={doc.markdown} onOpenDoc={open} className="max-w-4xl" />
        </div>
      </div>
    </div>
  )
}
