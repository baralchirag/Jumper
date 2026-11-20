import { useState } from 'react';
import { Code2 } from 'lucide-react';
import { Button, CopyButton, Dialog, SegmentedControl } from '@jumper/ui';
import { useRepoInfo } from './context';

type Format = 'markdown' | 'html';

interface Item {
  label: string;
  hint: string;
  path: string;
  alt: string;
  link: string;
  preview?: boolean;
}

/** Copy-paste snippets for READMEs and docs: live check badges and a picture of the board. */
export function EmbedMenu() {
  const info = useRepoInfo();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>('markdown');
  const origin = window.location.origin;
  const api = `${origin}/api/repos/${info.owner}/${info.name}`;
  const page = `${origin}/${info.owner}/${info.name}`;
  const items: Item[] = [
    { label: 'All checks', hint: 'Passing, failing or running, for the latest commit on the default branch.', path: `${api}/badge.svg`, alt: 'Checks', link: `${page}/checks` },
    { label: 'DRC', hint: 'Design rule check only.', path: `${api}/badge.svg?check=DRC`, alt: 'DRC', link: `${page}/checks` },
    { label: 'ERC', hint: 'Electrical rule check only.', path: `${api}/badge.svg?check=ERC`, alt: 'ERC', link: `${page}/checks` },
    { label: 'Board preview', hint: 'A 3D render of the board, updated with every push. Add ?view=top, bottom or drawing.', path: `${api}/preview.png`, alt: `${info.name} board`, link: page, preview: true },
  ];
  const iframe = `<iframe src="${origin}/embed/${info.owner}/${info.name}" width="100%" height="480" style="border:1px solid #d0d7de;border-radius:6px" title="${info.name} on Jumper" loading="lazy"></iframe>`;
  const snippet = (i: Item) =>
    format === 'markdown'
      ? `[![${i.alt}](${i.path})](${i.link})`
      : `<a href="${i.link}"><img src="${i.path}" alt="${i.alt}"${i.preview ? ' width="480"' : ''}></a>`;
  return (
    <>
      <Button size="sm" variant="invisible" leadingIcon={<Code2 size={14} />} onClick={() => setOpen(true)}>
        Embed
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Embed this board" width={640}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-md text-sm text-fg-muted">Paste these into a README or a docs page. They always show the current state of the default branch.</p>
            <SegmentedControl size="sm" value={format} onChange={setFormat} options={[{ value: 'markdown', label: 'Markdown' }, { value: 'html', label: 'HTML' }]} ariaLabel="Snippet format" />
          </div>
          {info.visibility === 'private' && (
            <p className="rounded-md border border-border bg-canvas-subtle p-3 text-xs text-fg-muted">
              This repository is private, so these images only load for people signed in to Jumper with access to it, for example in this repository&rsquo;s own README.
            </p>
          )}
          <ul className="space-y-4">
            {items.map((i) => (
              <li key={i.label} className="space-y-1.5">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{i.label}</span>
                  {!i.preview && <img src={i.path} alt="" height={20} className="h-5" />}
                </div>
                <p className="text-xs text-fg-muted">{i.hint}</p>
                <div className="flex gap-1">
                  <input readOnly value={snippet(i)} aria-label={`${i.label} snippet`} onFocus={(e) => e.target.select()} className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-xs" />
                  <CopyButton value={snippet(i)} size="md" />
                </div>
              </li>
            ))}
          </ul>
          {info.visibility === 'public' && !info.isEmpty && (
            <div className="space-y-1.5 border-t border-border pt-4">
              <span className="text-sm font-medium">Interactive viewer</span>
              <p className="text-xs text-fg-muted">Pan, zoom and switch between board, schematic and 3D, on any site that allows iframes (docs, blogs, Notion, project pages). Add ?view=sch or ?view=3d to open on another view.</p>
              <div className="flex gap-1">
                <input readOnly value={iframe} aria-label="Interactive viewer snippet" onFocus={(e) => e.target.select()} className="h-8 min-w-0 flex-1 rounded-sm border border-border bg-canvas-inset px-2 font-mono text-xs" />
                <CopyButton value={iframe} size="md" />
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
