// @vitest-environment jsdom
// Hostile READMEs, comments and issue bodies: nothing that runs script, navigates the page or loads active content
// may survive rendering.
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><circle r=5 /></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="  JaVaScRiPt:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '[x](javascript:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '![x](javascript:alert(1))',
  '<iframe src="https://evil.example" srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="evil.swf"></object><embed src="evil.swf">',
  '<form action="https://evil.example"><button formaction="javascript:alert(1)">go</button></form>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<base href="https://evil.example/">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<style>body{background:url(https://evil.example)}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<details open ontoggle=alert(1)>x</details>',
  '<video><source onerror=alert(1)></video>',
  '<a href="https://ok.example" onclick="alert(1)">x</a>',
];

const ACTIVE_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'button', 'meta', 'base', 'link', 'style'];

describe('rendered Markdown is inert', () => {
  it.each(PAYLOADS)('%s', (payload) => {
    const d = document.createElement('div');
    d.innerHTML = renderMarkdown(payload);
    for (const t of ACTIVE_TAGS) expect(d.querySelector(t), t).toBeNull();
    for (const el of d.querySelectorAll('*')) {
      for (const a of el.attributes) {
        expect(a.name.startsWith('on'), `${el.tagName} ${a.name}`).toBe(false);
        expect(a.name, el.tagName).not.toBe('style');
        expect(a.name, el.tagName).not.toBe('srcdoc');
        if (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(a.name)) {
          // eslint-disable-next-line no-control-regex -- strip control characters browsers ignore inside URLs
          expect(a.value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase()).not.toMatch(/^(javascript|data|vbscript):/);
        }
      }
    }
  });
});
