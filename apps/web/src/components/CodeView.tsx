import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, codeFolding } from '@codemirror/language';
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { keymap } from '@codemirror/view';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

function languageFor(path: string) {
  if (/\.kicad_(pcb|sch|sym|mod|pro|wks|dru)$|\.kicad_prl$/.test(path) && !path.endsWith('.kicad_pro')) return StreamLanguage.define(commonLisp);
  if (/\.ya?ml$/.test(path)) return StreamLanguage.define(yaml);
  return null;
}

/** Read-only, virtualized source view (handles multi-megabyte KiCad files). */
export function CodeView({ text, path, maxHeight = '75vh', line }: { text: string; path: string; maxHeight?: string; line?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const lang = languageFor(path);
    const view = new EditorView({
      parent: ref.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          codeFolding(),
          foldGutter(),
          keymap.of([...searchKeymap, ...foldKeymap]),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.theme({ '&': { maxHeight }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' } }),
          ...(lang ? [lang] : []),
        ],
      }),
    });
    if (line && line <= view.state.doc.lines) {
      const pos = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    }
    return () => view.destroy();
  }, [text, path, maxHeight, line]);
  return <div ref={ref} />;
}
