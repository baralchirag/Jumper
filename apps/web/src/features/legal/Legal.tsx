import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { SiteInfo } from '@jumper/shared';
import { Flash, PageSpinner, cx } from '@jumper/ui';
import { Markdown } from '../../shared/components/Markdown';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe } from '../../shared/lib/queries';
import privacy from './content/privacy.md?raw';
import refunds from './content/refunds.md?raw';
import terms from './content/terms.md?raw';

export type LegalDoc = 'terms' | 'privacy' | 'refunds';

const DOCS: { id: LegalDoc; title: string; source: string }[] = [
  { id: 'terms', title: 'Terms of service', source: terms },
  { id: 'privacy', title: 'Privacy policy', source: privacy },
  { id: 'refunds', title: 'Refund policy', source: refunds },
];

export function useSite() {
  return useQuery({ queryKey: ['site'], queryFn: () => api.get<SiteInfo>('/site'), staleTime: Infinity });
}

/** Fill the operator's details into a policy. Unset values read naturally instead of leaving a placeholder. */
export function fillLegal(source: string, site: SiteInfo | undefined): string {
  const values: Record<string, string> = {
    operator: site?.operator.name ?? 'the operator of this Jumper instance',
    email: site?.operator.email ? `[${site.operator.email}](mailto:${site.operator.email})` : 'the contact address published by the operator',
    jurisdiction: site?.operator.jurisdiction ?? 'the country where the operator is established',
    url: site?.publicUrl ?? window.location.origin,
  };
  return source.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}

function LegalPage({ doc }: { doc: LegalDoc }) {
  const site = useSite();
  const { data: me } = useMe();
  const current = DOCS.find((d) => d.id === doc)!;
  const source = useMemo(() => fillLegal(current.source, site.data), [current, site.data]);
  if (site.isLoading) return <PageSpinner />;
  const unconfigured = site.data && !site.data.operator.name;

  return (
    <PageContainer className="grid gap-10 py-12 md:grid-cols-[180px_minmax(0,1fr)] md:gap-14">
      <nav aria-label="Legal" className="md:sticky md:top-20 md:self-start">
        <p className="mb-2 text-xs font-medium text-fg">Legal</p>
        <ul className="space-y-0.5 border-l border-border-muted">
          {DOCS.map((d) => (
            <li key={d.id}>
              <Link
                to={`/${d.id}`}
                aria-current={d.id === doc ? 'page' : undefined}
                className={cx(
                  '-ml-px block border-l py-1 pl-3 text-[13px] no-underline transition-colors',
                  d.id === doc ? 'border-fg font-medium text-fg' : 'border-transparent text-fg-muted hover:border-fg-subtle hover:text-fg',
                )}
              >
                {d.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="min-w-0 max-w-[72ch]">
        {unconfigured && me?.isAdmin && (
          <Flash tone="warning" className="mb-8">
            This instance has not published its operator details. Set <code className="font-mono text-[0.9em]">OPERATOR_NAME</code>,{' '}
            <code className="font-mono text-[0.9em]">OPERATOR_EMAIL</code> and <code className="font-mono text-[0.9em]">OPERATOR_JURISDICTION</code> on the API, and
            have these policies reviewed for your situation before you take payments.
          </Flash>
        )}
        <p className="mb-3 font-mono text-xs text-fg-subtle">
          {site.data?.legalUpdated ? `Last updated ${site.data.legalUpdated}` : 'Legal'}
        </p>
        <Markdown source={source} />
      </article>
    </PageContainer>
  );
}

export const TermsPage = () => <LegalPage doc="terms" />;
export const PrivacyPage = () => <LegalPage doc="privacy" />;
export const RefundsPage = () => <LegalPage doc="refunds" />;
