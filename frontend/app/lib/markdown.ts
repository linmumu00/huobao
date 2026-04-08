import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

export function renderMarkdown(source: string): string {
  const raw = md.render(source || '')
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}

