import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting, foldGutter, foldKeymap, codeFolding } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
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
          // tok-* classes, coloured per theme in the UI styles (the library default is tuned for white pages only).
          syntaxHighlighting(classHighlighter),
          EditorView.theme({
            '&': { maxHeight, color: 'var(--pcb-fg)', backgroundColor: 'var(--pcb-canvas)' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
            '.cm-content': { caretColor: 'var(--pcb-fg)' },
            '.cm-gutters': { backgroundColor: 'var(--pcb-canvas-subtle)', color: 'var(--pcb-fg-subtle)', borderRight: '1px solid var(--pcb-border)' },
            '.cm-activeLine': { backgroundColor: 'var(--pcb-neutral-muted)' },
            '.cm-activeLineGutter': { backgroundColor: 'var(--pcb-neutral-muted)', color: 'var(--pcb-fg)' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--pcb-accent-muted) !important' },
            '.cm-selectionMatch': { backgroundColor: 'var(--pcb-accent-subtle)' },
            '.cm-searchMatch': { backgroundColor: 'var(--pcb-accent-muted)', outline: '1px solid var(--pcb-accent-emphasis)' },
            '.cm-foldPlaceholder': { backgroundColor: 'var(--pcb-canvas-inset)', border: '1px solid var(--pcb-border)', color: 'var(--pcb-fg-muted)' },
            '.cm-panels': { backgroundColor: 'var(--pcb-canvas-subtle)', color: 'var(--pcb-fg)', borderColor: 'var(--pcb-border)' },
            '.cm-textfield': { backgroundColor: 'var(--pcb-canvas)', color: 'var(--pcb-fg)', border: '1px solid var(--pcb-border)' },
          }),
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
