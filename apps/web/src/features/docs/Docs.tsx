import { useMemo } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { cx } from '@jumper/ui';
import jumperYml from './content/jumper-yml.md?raw';
import { Markdown } from '../../shared/components/Markdown';
import { NotFound, PageContainer } from '../../shared/components/common';
import accounts from './content/accounts.md?raw';
import apiDoc from './content/api.md?raw';
import designAnalysis from './content/design-analysis.md?raw';
import faq from './content/faq.md?raw';
import quickStart from './content/quick-start.md?raw';
import permissions from './content/permissions.md?raw';
import sharing from './content/sharing.md?raw';
import webhooks from './content/webhooks.md?raw';
import markdown from './content/markdown.md?raw';
import kicadPlugin from './content/kicad-plugin.md?raw';
import sshDoc from './content/ssh.md?raw';
import mirroring from './content/mirroring.md?raw';
import largeFiles from './content/large-files.md?raw';
import embeds from './content/embeds.md?raw';
import selfHosting from './content/self-hosting.md?raw';
import { markdownToc } from '../../shared/lib/markdown';

interface Doc {
  slug: string;
  title: string;
  source: string;
}

const SECTIONS: { title: string; docs: Doc[] }[] = [
  {
    title: 'Using Jumper',
    docs: [
      { slug: 'quick-start', title: 'Quick start', source: quickStart },
      { slug: 'mirroring', title: 'Connecting GitHub & GitLab', source: mirroring },
      { slug: 'kicad-plugin', title: 'KiCad plugin', source: kicadPlugin },
      { slug: 'ssh', title: 'Git over SSH', source: sshDoc },
      { slug: 'large-files', title: 'Large files (Git LFS)', source: largeFiles },
      { slug: 'accounts', title: 'Accounts & organizations', source: accounts },
      { slug: 'design-analysis', title: 'Design analysis', source: designAnalysis },
      { slug: 'sharing', title: 'Share links', source: sharing },
      { slug: 'jumper-yml', title: '.jumper.yml', source: jumperYml },
      { slug: 'markdown', title: 'Markdown', source: markdown },
    ],
  },
  {
    title: 'Integrating',
    docs: [
      { slug: 'embeds', title: 'Badges & board previews', source: embeds },
      { slug: 'webhooks', title: 'Webhooks', source: webhooks },
      { slug: 'api', title: 'REST API', source: apiDoc },
    ],
  },
  {
    title: 'Running Jumper',
    docs: [
      { slug: 'permissions', title: 'Permissions & security', source: permissions },
      { slug: 'self-hosting', title: 'Self-hosting', source: selfHosting },
      { slug: 'faq', title: 'Troubleshooting', source: faq },
    ],
  },
];

const ALL = SECTIONS.flatMap((s) => s.docs);
/** Old slugs still linked from elsewhere. */
const ALIASES: Record<string, string> = { 'getting-started': 'quick-start' };

export function DocsPage() {
  const { slug: raw = 'quick-start' } = useParams({ strict: false }) as { slug?: string };
  const slug = ALIASES[raw] ?? raw;
  const doc = ALL.find((d) => d.slug === slug);
  const toc = useMemo(() => (doc ? markdownToc(doc.source).filter((t) => t.depth === 2 || t.depth === 3) : []), [doc]);
  if (!doc) return <NotFound>There is no page called “{slug}” in the docs.</NotFound>;
  const i = ALL.indexOf(doc);
  const prev = ALL[i - 1];
  const next = ALL[i + 1];

  return (
    <PageContainer className="grid gap-8 py-10 md:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_200px] xl:gap-12">
      <nav aria-label="Documentation" className="md:sticky md:top-20 md:self-start">
        {SECTIONS.map((s) => (
          <div key={s.title} className="mb-6">
            <p className="mb-2 text-xs font-medium text-fg">{s.title}</p>
            <ul className="space-y-0.5 border-l border-border-muted">
              {s.docs.map((d) => (
                <li key={d.slug}>
                  <Link
                    to="/docs/$slug"
                    params={{ slug: d.slug }}
                    aria-current={d.slug === doc.slug ? 'page' : undefined}
                    className={cx(
                      '-ml-px block border-l py-1 pl-3 text-[13px] no-underline transition-colors',
                      d.slug === doc.slug ? 'border-fg font-medium text-fg' : 'border-transparent text-fg-muted hover:border-fg-subtle hover:text-fg',
                    )}
                  >
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <article className="min-w-0">
        <p className="mb-3 font-mono text-xs text-fg-subtle">Docs / {doc.title}</p>
        <Markdown source={doc.source} />
        <div className="mt-14 grid grid-cols-2 gap-4 border-t border-border pt-5 text-[13px]">
          {prev ? (
            <Link to="/docs/$slug" params={{ slug: prev.slug }} className="group no-underline">
              <span className="block text-xs text-fg-subtle">Previous</span>
              <span className="text-fg group-hover:text-accent">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to="/docs/$slug" params={{ slug: next.slug }} className="group text-right no-underline">
              <span className="block text-xs text-fg-subtle">Next</span>
              <span className="text-fg group-hover:text-accent">{next.title}</span>
            </Link>
          )}
        </div>
      </article>

      {toc.length > 1 && (
        <aside className="hidden xl:sticky xl:top-20 xl:block xl:self-start">
          <p className="mb-2 text-xs font-medium text-fg">On this page</p>
          <ul className="space-y-1.5 text-[13px]">
            {toc.map((t) => (
              <li key={t.id} className={t.depth === 3 ? 'pl-3' : ''}>
                <a href={`#${t.id}`} className="text-fg-muted no-underline hover:text-fg">
                  {t.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </PageContainer>
  );
}
