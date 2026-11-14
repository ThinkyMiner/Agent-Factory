// Renders untrusted markdown (specs, reviews, issues, audits, BLOCKED.md). Raw HTML is never
// rendered: it is shown as code, so you can see that someone wrote it. Images are never loaded
// (an image URL is a request someone else chose). Only http(s) and mailto links are live.
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

type MdNode = { type: string; value?: string; children?: MdNode[]; lang?: string | null }

/** remark plugin: turn raw HTML nodes into visible code. */
function htmlAsCode() {
  return (tree: MdNode) => {
    const walk = (node: MdNode, block: boolean) => {
      for (const child of node.children ?? []) {
        if (child.type === 'html') {
          child.type = block ? 'code' : 'inlineCode'
          if (block) child.lang = 'html'
        } else walk(child, child.type === 'root' || child.type === 'blockquote' || child.type === 'listItem')
      }
    }
    walk(tree, true)
  }
}

const SAFE_URL = /^(https?:|mailto:)/i

export function Md({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('md', className)}>
      <Markdown
        remarkPlugins={[remarkGfm, htmlAsCode]}
        skipHtml={false}
        urlTransform={(url) => (SAFE_URL.test(url) ? url : '')}
        components={{
          // untrusted text never gets a page-level heading: # becomes level 4, ## level 5, the rest 6
          h1: ({ children }) => <h4 className="md-h1">{children}</h4>,
          h2: ({ children }) => <h5 className="md-h2">{children}</h5>,
          h3: ({ children }) => <h6 className="md-h3">{children}</h6>,
          h4: ({ children }) => <h6 className="md-h3">{children}</h6>,
          h5: ({ children }) => <h6 className="md-h3">{children}</h6>,
          h6: ({ children }) => <h6 className="md-h3">{children}</h6>,
          a: ({ href, children }) =>
            href && SAFE_URL.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt, src }) => (
            <span className="text-muted" title={typeof src === 'string' ? src : undefined}>
              [image{alt ? `: ${alt}` : ''}, not loaded]
            </span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

export function Raw({ text, className }: { text: string; className?: string }) {
  return <pre tabIndex={0} className={cn('overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap', className)}>{text}</pre>
}
