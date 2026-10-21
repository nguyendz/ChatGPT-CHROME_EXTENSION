import { Children, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { safeExportLink } from '../../../lib/export-document.ts';

const schema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter(tag => !['picture', 'source'].includes(tag)),
  strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'object', 'embed', 'video', 'audio', 'form'],
};

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = href ? safeExportLink(href) : undefined;
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>;
}

function BlockedImage({ alt }: { alt?: string }) {
  return <span className="blocked-media">[Image not loaded{alt ? `: ${alt}` : ''}]</span>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const html = isValidElement<{ className?: string; children?: ReactNode }>(code) &&
    typeof code.props.className === 'string' && /\blanguage-(html|htm)\b/i.test(code.props.className) &&
    typeof code.props.children === 'string' ? code.props.children : null;
  const [preview, setPreview] = useState(false);
  if (html === null) return <pre>{children}</pre>;
  return <div className="html-code-block">
    <div className="code-toolbar"><span>HTML source</span><button type="button"
      aria-expanded={preview} onClick={() => setPreview(value => !value)}>
      {preview ? 'Hide HTML preview' : 'Preview HTML'}
    </button></div>
    <pre>{children}</pre>
    {preview && <section className="html-preview" aria-label="Safe HTML preview">
      <p className="preview-note">Safe preview: scripts, inline styles, embedded pages, and remote media are disabled.</p>
      <MarkdownBody text={html} allowPreview={false} />
    </section>}
  </div>;
}

function MarkdownBody({ text, allowPreview = true }: { text: string; allowPreview?: boolean }) {
  return <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
    components={{ a: SafeLink, img: BlockedImage, pre: allowPreview ? CodeBlock : undefined }}>
    {text}
  </Markdown>;
}

export function MessageContent({ text, contentType }: { text: string; contentType: string | null }) {
  if (contentType === 'code') return <pre className="saved-code"><code>{text || '[No saved code]'}</code></pre>;
  return <div className="message-content"><MarkdownBody text={text || '[No saved text in this message]'} /></div>;
}
