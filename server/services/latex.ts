import type { Source } from '../../shared/types.ts'

/**
 * Minimal Markdown → LaTeX conversion for agent reports: headings, emphasis,
 * lists, quotes, code, tables, links, math (passed through), citations
 * [clé] / [clé, p.X] → \cite, note links [[slug]] → sans-serif tag.
 * Compiles with LuaLaTeX or XeLaTeX (Unicode text and math symbols).
 */

const TEXT_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '#': '\\#', '$': '\\$', '%': '\\%', '&': '\\&', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
}

export function escapeTex(s: string): string {
  return s.replace(/[\\{}#$%&_~^]/g, c => TEXT_ESCAPES[c])
}

/** BibTeX keys: letters, digits and a few separators. */
export function bibKey(citationKey: string): string {
  return citationKey.replace(/[^A-Za-z0-9:._-]/g, '')
}

interface InlineCtx {
  keys: Set<string>
}

/** Inline formatting outside math. Math segments are protected first. */
function inline(text: string, ctx: InlineCtx): string {
  const math: string[] = []
  // protect $$…$$, \[…\], $…$ and \(…\) (kept verbatim: they are already LaTeX)
  let t = text.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)[^$\n]+?(?<!\s)\$/g, m => {
    math.push(m)
    return `\u0000M${math.length - 1}\u0000`
  })
  const code: string[] = []
  t = t.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    code.push(`\\texttt{${escapeTex(c)}}`)
    return `\u0000C${code.length - 1}\u0000`
  })
  const links: string[] = []
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    links.push(`\\href{${url.replace(/[%#]/g, c => `\\${c}`)}}{${escapeTex(label)}}`)
    return `\u0000L${links.length - 1}\u0000`
  })
  t = t.replace(/\[\[([^\]\n]+)\]\]/g, (_m, slug: string) => {
    links.push(`\\textsf{${escapeTex(slug)}}`)
    return `\u0000L${links.length - 1}\u0000`
  })
  // [clé], [clé, p. 12], [clé1; clé2]
  t = t.replace(/\[([^\]\n]{1,200})\]/g, (m, inner: string) => {
    const parts = inner.split(/\s*;\s*/)
    const cites = parts.map(p => {
      const mm = /^([^,\s]+)(?:,\s*(.+))?$/.exec(p.trim())
      if (!mm || !ctx.keys.has(mm[1])) return undefined
      return mm[2] ? `\\cite[${escapeTex(mm[2].replace(/^p\.\s*/, 'p.~'))}]{${bibKey(mm[1])}}` : `\\cite{${bibKey(mm[1])}}`
    })
    if (cites.some(c => !c)) return m
    links.push(cites.join(''))
    return `\u0000L${links.length - 1}\u0000`
  })
  t = escapeTex(t)
  t = t.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}').replace(/(^|[^\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1\\emph{$2}')
  t = t.replace(/\u0000([MCL])(\d+)\u0000/g, (_m, kind: string, i: string) => (kind === 'M' ? math : kind === 'C' ? code : links)[Number(i)])
  return t
}

function table(lines: string[], ctx: InlineCtx): string {
  const rows = lines.filter(l => !/^\s*\|?\s*:?-{2,}/.test(l)).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim(), ctx)))
  const n = Math.max(...rows.map(r => r.length))
  const head = rows[0]
  const body = rows.slice(1)
  return [
    '\\begin{center}\\small',
    `\\begin{tabular}{${'l'.repeat(n)}}`,
    '\\hline',
    `${head.map(c => `\\textbf{${c}}`).join(' & ')} \\\\`,
    '\\hline',
    ...body.map(r => `${[...r, ...Array(n - r.length).fill('')].join(' & ')} \\\\`),
    '\\hline',
    '\\end{tabular}',
    '\\end{center}',
  ].join('\n')
}

/** Body only (no preamble). The first `# Title` is returned separately. */
export function markdownToLatex(md: string, opts: { keys: Iterable<string> }): { title?: string; body: string } {
  const ctx: InlineCtx = { keys: new Set(opts.keys) }
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let title: string | undefined
  const lists: Array<'itemize' | 'enumerate'> = []
  const closeLists = (): void => {
    while (lists.length) out.push(`\\end{${lists.pop()}}`)
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // fenced code
    if (/^\s*```/.test(line)) {
      closeLists()
      const block: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) block.push(lines[i])
      out.push('\\begin{verbatim}', ...block, '\\end{verbatim}')
      continue
    }
    // display math on its own lines
    if (/^\s*\$\$\s*$/.test(line)) {
      closeLists()
      const block: string[] = []
      while (++i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) block.push(lines[i])
      out.push('\\[', ...block, '\\]')
      continue
    }
    // tables
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeLists()
      const block: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++])
      i--
      out.push(table(block, ctx))
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeLists()
      const level = h[1].length
      const text = inline(h[2].trim(), ctx)
      if (level === 1 && title === undefined) {
        title = h[2].trim()
        continue
      }
      out.push(level <= 2 ? `\\section{${text}}` : level === 3 ? `\\subsection{${text}}` : `\\paragraph{${text}}`)
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeLists()
      out.push('\\medskip\\hrule\\medskip')
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      closeLists()
      const block: string[] = [q[1]]
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) block.push(lines[++i].replace(/^\s*>\s?/, ''))
      out.push('\\begin{quote}', block.map(b => (b.trim() ? inline(b, ctx) : '\\par')).join('\n'), '\\end{quote}')
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].replace(/\t/g, '  ').length / 2) + 1)
      const kind = /\d/.test(li[2]) ? 'enumerate' : 'itemize'
      while (lists.length > depth) out.push(`\\end{${lists.pop()}}`)
      if (lists.length === depth && lists[depth - 1] !== kind) out.push(`\\end{${lists.pop()}}`)
      while (lists.length < depth) {
        lists.push(kind)
        out.push(`\\begin{${kind}}`)
      }
      const text = li[3].replace(/^\[( |x|X)\]\s+/, (_m, c: string) => (c === ' ' ? '$\\square$ ' : '$\\boxtimes$ '))
      out.push(`\\item ${inline(text, ctx)}`)
      continue
    }
    if (!line.trim()) {
      closeLists()
      out.push('')
      continue
    }
    if (lists.length && /^\s+\S/.test(line)) {
      out.push(inline(line.trim(), ctx))
      continue
    }
    closeLists()
    out.push(inline(line, ctx))
  }
  closeLists()
  return { title, body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

export function latexDocument(opts: { title: string; author: string; date: string; abstract?: string; body: string; bibliography?: string }): string {
  return `% Généré par Noesis. Compilation : latexmk -lualatex <fichier>.tex (ou -xelatex) ; bibtex pour la bibliographie.
\\documentclass[11pt,a4paper]{article}
\\usepackage{fontspec}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{unicode-math}
\\usepackage[french,english]{babel}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage[hidelinks]{hyperref}
\\usepackage{natbib}
\\setlength{\\parskip}{0.4em}
\\title{${escapeTex(opts.title)}}
\\author{${escapeTex(opts.author)}}
\\date{${escapeTex(opts.date)}}
\\begin{document}
\\selectlanguage{french}
\\maketitle
${opts.abstract ? `\\begin{abstract}\n${opts.abstract}\n\\end{abstract}\n` : ''}
${opts.body}
${opts.bibliography ? `\n\\bibliographystyle{plainnat}\n\\bibliography{${opts.bibliography}}\n` : ''}
\\end{document}
`
}

function bibEscape(s: string): string {
  return s.replace(/[{}]/g, '').replace(/([&%$#_])/g, '\\$1')
}

export function toBibtex(sources: Source[]): string {
  return sources.map(s => {
    const type = s.arxivId && !s.venue ? 'misc' : s.kind === 'book' ? 'book' : s.venue ? 'article' : 'misc'
    const fields: Array<[string, string | number | undefined]> = [
      ['title', `{${bibEscape(s.title)}}`],
      ['author', s.authors.length ? bibEscape(s.authors.join(' and ')) : undefined],
      ['year', s.year],
      [type === 'book' ? 'publisher' : 'journal', s.venue ? bibEscape(s.venue) : undefined],
      ['doi', s.doi],
      ['eprint', s.arxivId],
      ['archivePrefix', s.arxivId ? 'arXiv' : undefined],
      ['url', s.url ?? s.pdfUrl],
      ['note', s.origin === 'human' ? 'Document fourni par l\'humain' : s.status !== 'full_text' ? 'Cité d\'après les métadonnées (texte intégral non lu)' : undefined],
    ]
    const body = fields.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  ${k} = {${v}}`).join(',\n')
    return `@${type}{${bibKey(s.citationKey)},\n${body}\n}`
  }).join('\n\n')
}
