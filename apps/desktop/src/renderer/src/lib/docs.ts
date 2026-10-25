// The end-user documentation, bundled from the repository's docs/ folder at build time so Help works offline
// and always matches the installed version.
import { Marked, type Tokens } from 'marked'
import userGuide from '../../../../../../docs/user-guide.md?raw'
import registries from '../../../../../../docs/registries.md?raw'
import troubleshooting from '../../../../../../docs/troubleshooting.md?raw'
import security from '../../../../../../docs/security.md?raw'

export interface HelpDoc {
  id: string
  title: string
  markdown: string
}

export const HELP_DOCS: HelpDoc[] = [
  { id: 'user-guide', title: 'User guide', markdown: userGuide },
  { id: 'registries', title: 'Registry setup', markdown: registries },
  { id: 'troubleshooting', title: 'Troubleshooting', markdown: troubleshooting },
  { id: 'security', title: 'Security', markdown: security }
]

export function getDoc(id: string | null | undefined): HelpDoc {
  return HELP_DOCS.find((d) => d.id === id) ?? HELP_DOCS[0]
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

const marked = new Marked({ gfm: true })
marked.use({
  renderer: {
    heading({ tokens, depth, text }: Tokens.Heading) {
      return `<h${depth} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    }
  }
})

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false })
}

/** Level-2 headings, for the table of contents. */
export function headings(markdown: string): { id: string; text: string }[] {
  return marked
    .lexer(markdown)
    .filter((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 2)
    .map((h) => ({ id: slugify(h.text), text: h.text.replace(/[`*_]/g, '') }))
}

/**
 * The part of a document that starts at an explicit `<a id="…"></a>` anchor (as used per provider in
 * registries.md) and ends at the next anchor.
 */
export function docSection(markdown: string, anchor: string): string | undefined {
  const marker = `<a id="${anchor}"></a>`
  const start = markdown.indexOf(marker)
  if (start < 0) return undefined
  const next = markdown.indexOf('<a id="', start + marker.length)
  return markdown.slice(start + marker.length, next < 0 ? undefined : next).trim()
}
