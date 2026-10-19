import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import 'katex/dist/katex.min.css'
import { cx } from './ui'

/** `[[slug]]` wiki links become clickable note references. */
function linkify(text: string): string {
  return text.replace(/\[\[([^\]\n]{1,120})\]\]/g, (_m, slug: string) => `[${slug}](#note:${encodeURIComponent(slug.trim())})`)
}

/** Many models write \( … \) and \[ … \]; remark-math expects $ … $ / $$ … $$. */
function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`)
}

export const Markdown = memo(function Markdown({ text, className, onNoteClick, small, resolveUrl }: {
  text: string
  className?: string
  onNoteClick?: (slug: string) => void
  small?: boolean
  /** Rewrites relative image/link targets (e.g. workspace files referenced by a report). */
  resolveUrl?: (src: string) => string
}) {
  return (
    <div className={cx('prose-noesis', small && 'prose-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          img: ({ src, alt }) => {
            const raw = typeof src === 'string' ? src : ''
            const url = resolveUrl && raw && !/^(https?:|data:|\/)/.test(raw) ? resolveUrl(raw) : raw
            return <img src={url} alt={alt ?? ''} loading="lazy" />
          },
          a: ({ href, children }) => {
            if (href?.startsWith('#note:')) {
              const slug = decodeURIComponent(href.slice(6))
              return (
                <a className="wikilink" onClick={e => { e.preventDefault(); onNoteClick?.(slug) }} href={href}>
                  {children}
                </a>
              )
            }
            const target = resolveUrl && href && !/^(https?:|mailto:|#|\/)/.test(href) ? resolveUrl(href) : href
            return <a href={target} target="_blank" rel="noreferrer">{children}</a>
          },
        }}
      >
        {normalizeMath(linkify(text))}
      </ReactMarkdown>
    </div>
  )
})
