import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { c, cpp } from '@codemirror/legacy-modes/mode/clike';
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { python } from '@codemirror/legacy-modes/mode/python';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';


const MODES: Record<string, StreamParser<unknown>> = {
  sh: shell,
  bash: shell,
  shell: shell,
  console: shell,
  zsh: shell,
  yaml: yaml,
  yml: yaml,
  js: javascript,
  javascript: javascript,
  jsx: javascript,
  ts: typescript,
  typescript: typescript,
  tsx: typescript,
  json: json,
  python: python,
  py: python,
  c: c,
  h: c,
  cpp: cpp,
  'c++': cpp,
  rust: rust,
  rs: rust,
  toml: toml,
  diff: diff,
  patch: diff,
  // KiCad files are S-expressions.
  lisp: commonLisp,
  sexp: commonLisp,
  kicad: commonLisp,
  kicad_pcb: commonLisp,
  kicad_sch: commonLisp,
} as Record<string, StreamParser<unknown>>;

const cache = new Map<string, StreamLanguage<unknown>>();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Highlight `code` to HTML using `tok-*` classes, or null when the language is unknown. */
export function highlightToHtml(code: string, lang: string): string | null {
  const key = lang.toLowerCase();
  const mode = MODES[key];
  if (!mode) return null;
  let language = cache.get(key);
  if (!language) {
    language = StreamLanguage.define(mode);
    cache.set(key, language);
  }
  const tree = language.parser.parse(code);
  let out = '';
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      out += classes ? `<span class="${classes}">${esc(text)}</span>` : esc(text);
    },
    () => {
      out += '\n';
    },
  );
  return out;
}
