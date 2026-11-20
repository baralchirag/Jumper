// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownToc, renderMarkdown } from './markdown';

const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('renderMarkdown', () => {
  it('strips scripts, handlers and non-checkbox inputs', () => {
    const d = dom(renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)"><input type="text" value="x">\n\n- [x] done'));
    expect(d.querySelector('script')).toBeNull();
    expect(d.querySelector('img')?.getAttribute('onerror')).toBeNull();
    const inputs = d.querySelectorAll('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.getAttribute('type')).toBe('checkbox');
    expect(inputs[0]!.hasAttribute('disabled')).toBe(true);
    expect(inputs[0]!.hasAttribute('checked')).toBe(true);
  });

  it('turns GitHub alert blockquotes into alerts', () => {
    const d = dom(renderMarkdown('> [!WARNING]\n> Check the polarity.'));
    const alert = d.querySelector('.markdown-alert-warning');
    expect(alert).not.toBeNull();
    expect(alert!.querySelector('.markdown-alert-title')!.textContent).toBe('Warning');
    expect(alert!.textContent).toContain('Check the polarity.');
    expect(alert!.textContent).not.toContain('[!WARNING]');
    expect(d.querySelector('blockquote')).toBeNull();
  });

  it('gives headings prefixed, unique anchors that match the TOC', () => {
    const md = '## Stack-up\n\n## Stack-up\n\n### `.jumper.yml` keys';
    const d = dom(renderMarkdown(md));
    const ids = [...d.querySelectorAll('h2, h3')].map((h) => h.id);
    expect(ids).toEqual(['md-stack-up', 'md-stack-up-1', 'md-jumperyml-keys']);
    expect(markdownToc(md).map((t) => t.id)).toEqual(ids);
  });

  it('links mentions and pull refs outside code', () => {
    const d = dom(renderMarkdown('Thanks @ana, fixed in #12. `@notme #3` email a@b.co', { repo: { owner: 'o', name: 'r' } }));
    const links = [...d.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    // The email is a GFM autolink, never a mention.
    expect(links).toEqual(['/ana', 'mailto:a@b.co']);
    expect(d.querySelector('code')!.textContent).toBe('@notme #3');
  });

  it('highlights known fence languages and leaves others alone', () => {
    const d = dom(renderMarkdown('```yaml\nchecks: true\n```\n\n```brainfuck\n+++\n```'));
    const [yaml, other] = [...d.querySelectorAll('pre')];
    expect(yaml!.getAttribute('data-lang')).toBe('yaml');
    expect(yaml!.querySelector('span[class^="tok-"]')).not.toBeNull();
    expect(other!.querySelector('span')).toBeNull();
  });

  it('opens external links in a new tab and resolves relative ones', () => {
    const d = dom(renderMarkdown('[a](https://example.com) [b](docs/x.md)', { resolveLink: (h) => `/o/r/blob/main/${h}` }));
    const [ext, rel] = [...d.querySelectorAll('a')];
    expect(ext!.getAttribute('target')).toBe('_blank');
    expect(ext!.getAttribute('rel')).toContain('noopener');
    expect(rel!.getAttribute('href')).toBe('/o/r/blob/main/docs/x.md');
  });
});
