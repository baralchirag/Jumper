import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Plus } from 'lucide-react';
import type { FollowList, RepoInfo } from '@jumper/shared';
import { Avatar, PageSpinner, RelativeTime, buttonClass, cx } from '@jumper/ui';
import { BoardDiff, BOARD, CHANGES, isShown, kindLabel, type Change } from './diff/BoardDiff';
import reviewLight from './shots/review-light.webp';
import reviewDark from './shots/review-dark.webp';
import checksLight from './shots/checks-light.webp';
import checksDark from './shots/checks-dark.webp';
import fabLight from './shots/fab-light.webp';
import fabDark from './shots/fab-dark.webp';
import { RepoList, RepoThumb } from '../../shared/components/RepoList';
import { PageContainer } from '../../shared/components/common';
import { api } from '../../shared/lib/api';
import { useMe, wasSignedIn } from '../../shared/lib/queries';

/** Screenshots of the real app (a pull request, the checks page, the outputs page), light and dark. */
const PUSH = [
  {
    title: 'Review on the board',
    body: 'Comment on a footprint, a pad or a track. Compare side by side, overlaid or swiped, matched by KiCad UUIDs rather than lines of text.',
    slug: 'pull-requests',
    shot: { light: reviewLight, dark: reviewDark, alt: 'A pull request in Jumper: the board before and after, with the added, removed and modified footprints listed beside it.' },
  },
  {
    title: 'ERC and DRC on every push',
    body: 'kicad-cli runs in a sandbox on each commit. Required checks keep a branch from merging until the design is clean.',
    slug: 'jumper-yml',
    shot: { light: checksLight, dark: checksDark, alt: 'The checks page: BOM, DRC, ERC, exports and renders for one commit, with the DRC errors expanded.' },
  },
  {
    title: 'A fab package for every commit',
    body: 'Gerbers, drill, BOM and pick-and-place in JLCPCB format, with live stock and price breaks from LCSC, Mouser and DigiKey.',
    slug: 'releases',
    shot: { light: fabLight, dark: fabDark, alt: 'The outputs page: the JLCPCB package, Gerbers, pick-and-place, BOM, PDFs and 3D files for a commit, with the board PDF open.' },
  },
] as const;

const STEPS = [
  { title: 'Commit the board.', body: 'Push over HTTPS or SSH, or straight from KiCad with the Jumper plugin.' },
  { title: 'Review the change.', body: 'Every change shown on the board, comments pinned to parts, and checks that hold the merge until the design is clean.' },
  { title: 'Order the panel.', body: 'Gerbers, drill, BOM and pick-and-place packaged for JLCPCB, PCBWay or OSH Park.' },
] as const;

function PrimaryCta({ className, label = 'Start a project' }: { className?: string; label?: string }) {
  return (
    <Link to="/signup" className={cx('lp-cta group/cta', className)}>
      <span className="roll">
        <span>{label}</span>
        <span aria-hidden>{label}</span>
      </span>
      <ArrowUpRight size={18} aria-hidden className="arrow-travel" />
    </Link>
  );
}

/** The three things every push gets; hovering or focusing a row shows that screen from the app. */
function PushShowcase() {
  const [active, setActive] = useState(0);
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
      <ul className="border-t border-[var(--lp-ink)]">
        {PUSH.map((n, i) => (
          <li key={n.title} className="border-b border-[var(--lp-line)]">
            <Link
              to="/docs/$slug"
              params={{ slug: n.slug }}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              aria-describedby="push-shot"
              data-active={i === active || undefined}
              className="lp-row group/row"
            >
              <span className="lp-row-title">{n.title}</span>
              <span className="text-[15px] leading-relaxed text-[var(--lp-muted)]">{n.body}</span>
              <ArrowUpRight size={20} aria-hidden className="lp-row-arrow" />
            </Link>
          </li>
        ))}
      </ul>
      <figure id="push-shot" className="lp-shot lg:sticky lg:top-20 lg:self-start">
        {PUSH.map((n, i) => (
          <div key={n.title} className="lp-shot-frame" data-on={i === active || undefined} aria-hidden={i !== active}>
            <img src={n.shot.light} alt={i === active ? n.shot.alt : ''} className="lp-shot-light" loading="lazy" decoding="async" />
            <img src={n.shot.dark} alt={i === active ? n.shot.alt : ''} className="lp-shot-dark" loading="lazy" decoding="async" />
          </div>
        ))}
        <figcaption className="mt-3 text-[13px] text-[var(--lp-muted)]">
          {['A pull request', 'The checks page', 'The outputs page'][active]}, screenshotted from Jumper.
        </figcaption>
      </figure>
    </div>
  );
}

function Landing() {
  const [position, setPosition] = useState(0);
  const reveal = (c: Change) => setPosition(Math.min(100, c.box[2]! * 100 + 3));

  return (
    <div className="lp">
      {/* The specimen: the title, then the board at full width with the wipe under it. */}
      <section className="lp-wrap pb-20 pt-14 md:pb-28 md:pt-20">
        <div className="grid items-end gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
          <h1 className="lp-title font-title">See what changed.</h1>
          <div className="lg:pb-3">
            <p className="text-pretty text-[17px] leading-relaxed text-[var(--lp-muted)]">
              Git hosting for KiCad. Every commit is rendered, checked and compared as a board, so a review happens where the design is.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <PrimaryCta />
              <Link to="/explore" search={{ q: '' }} className="lp-link text-[15px]">
                Explore projects
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-12 md:mt-16">
          <BoardDiff position={position} onChange={setPosition} />
        </div>
      </section>

      {/* The change, itemised: each cell lights as the wipe passes it; clicking one wipes to it. */}
      <section aria-labelledby="changes-h" className="border-t border-[var(--lp-line)]">
        <div className="lp-wrap py-16 md:py-20">
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
            <h2 id="changes-h" className="text-[clamp(1.5rem,1.2rem+1vw,2rem)] font-medium tracking-[-0.02em]">
              The same change, itemised
            </h2>
            <p className="text-sm text-[var(--lp-muted)]">
              {BOARD.name} by {BOARD.author} · <span className="whitespace-nowrap">{BOARD.license}</span> ·{' '}
              <a href={BOARD.url} target="_blank" rel="noreferrer" className="lp-link">
                source
              </a>
              . Rev B is an example change made for this page.
            </p>
          </div>
          <ol className="mt-8 grid border-l border-t border-[var(--lp-line)] sm:grid-cols-2 lg:grid-cols-3">
            {CHANGES.map((c) => {
              const on = isShown(c, position);
              return (
                <li key={c.id} className="border-b border-r border-[var(--lp-line)]">
                  <button type="button" onClick={() => reveal(c)} aria-pressed={on} data-kind={c.kind} className={cx('lp-cell', on && 'is-on')}>
                    <span className="flex items-center justify-between font-mono text-[12.5px]">
                      <span className="lp-kind">{kindLabel(c)}</span>
                      <span className="text-[var(--lp-muted)]">{c.ref}</span>
                    </span>
                    <span className="mt-6 block text-[19px] font-medium leading-snug tracking-[-0.01em]">{c.title}</span>
                    <span className="mt-2 block text-[14px] leading-relaxed text-[var(--lp-muted)]">{c.detail}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* What else every push gets, set as type rather than cards. */}
      <section aria-labelledby="push-h" className="border-t border-[var(--lp-line)]">
        <div className="lp-wrap py-20 md:py-28">
          <h2 id="push-h" className="mb-10 text-[clamp(1.5rem,1.2rem+1vw,2rem)] font-medium leading-tight tracking-[-0.02em] md:mb-14">
            And on every push
          </h2>
          <PushShowcase />
        </div>
      </section>

      {/* Close: the three steps as one finished wipe, on a field of the accent colour. */}
      <section aria-labelledby="close-h" className="lp-close">
        <div className="lp-wrap pb-16 pt-20 md:pb-20 md:pt-28">
          <h2 id="close-h" className="sr-only">
            Commit the board. Review the change. Order the panel.
          </h2>
          <ol className="lp-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="lp-step">
                <span aria-hidden className="lp-step-node">
                  {i === STEPS.length - 1 ? <span className="lp-step-handle" /> : <span className="lp-step-tick" />}
                </span>
                <span className="font-mono text-[12.5px] tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="lp-step-title">{step.title}</h3>
                <p className="mt-4 max-w-[22rem] text-[15px] leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-16 flex flex-wrap items-center justify-between gap-x-10 gap-y-8 border-t border-[var(--lp-ink)] pt-8 md:mt-24">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <PrimaryCta className="lp-cta-ink" />
              <Link to="/login" className="lp-link text-[15px]">
                I already have an account
              </Link>
            </div>
            <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>KiCad 8 and 9</span>
            </p>
          </div>
        </div>
      </section>

      <style>{LANDING_CSS}</style>
    </div>
  );
}

const LANDING_CSS = `
.lp {
  /* Landing names for the shared tokens (packages/ui/src/styles.css), so the page follows the theme. */
  --lp-paper: var(--pcb-page);
  --lp-ink: var(--pcb-fg);
  --lp-muted: var(--pcb-fg-muted);
  --lp-line: var(--pcb-border);
  --lp-accent: var(--pcb-accent-emphasis);
  --lp-accent-ink: var(--pcb-select);
  --lp-edge: #121314;
  --lp-tick-on: var(--pcb-select);
  background: var(--lp-paper);
  color: var(--lp-ink);
}
.lp ::selection { background: var(--lp-accent); color: var(--lp-edge); }
.lp :focus-visible { outline: 2px solid var(--lp-ink); outline-offset: 3px; }
.lp-wrap { width: 100%; max-width: 1320px; margin-inline: auto; padding-inline: 20px; }
@media (min-width: 768px) { .lp-wrap { padding-inline: 40px; } }
.lp-title { font-size: clamp(3.4rem, 1.1rem + 7.4vw, 8.75rem); font-weight: 500; line-height: .9; letter-spacing: -0.04em; margin-left: -0.05em; }

.lp-cta { display: inline-flex; align-items: center; gap: 12px; height: 48px; padding: 0 16px 0 20px; border-radius: 4px;
  background: var(--lp-accent); color: var(--lp-edge); font-size: 15px; font-weight: 500; text-decoration: none;
  transition: background-color .25s var(--ease-route), color .25s var(--ease-route); }
.lp-cta:hover { background: var(--lp-ink); color: var(--lp-paper); }
.lp-link { color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px;
  text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); transition: text-decoration-color .2s; }
.lp-link:hover { text-decoration-color: currentColor; }

/* The wipe */
.lp-seam { width: 0; }
.lp-seam::before { content: ''; position: absolute; inset: -6px 0; left: -2px; width: 4px; background: var(--lp-accent); box-shadow: 0 0 0 1px var(--lp-edge); }
.lp-ring { border: 2px solid var(--lp-accent); border-radius: 6px; box-shadow: 0 0 0 1.5px var(--lp-edge), inset 0 0 0 1.5px var(--lp-edge); opacity: 0; transform: scale(1.6);
  transition: opacity .35s var(--ease-route), transform .5s var(--ease-route); pointer-events: none; }
.lp-ring.is-on { opacity: 1; transform: scale(1); }
.lp-ring-tag { position: absolute; left: -3.5px; box-shadow: 0 0 0 1.5px var(--lp-edge); bottom: calc(100% + 4px); padding: 1px 6px; border-radius: 3px;
  background: var(--lp-accent); color: var(--lp-edge); font: 500 12px/18px "JetBrains Mono Variable", ui-monospace, monospace; white-space: nowrap; }
.lp { --lp-add: #1f883d; --lp-del: #cf222e; --lp-mod: var(--lp-accent); }
.lp-ring[data-kind='added'] { border-color: var(--lp-add); background: color-mix(in srgb, var(--lp-add) 16%, transparent); }
.lp-ring[data-kind='removed'] { border-color: var(--lp-del); background: color-mix(in srgb, var(--lp-del) 18%, transparent);
  background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--lp-del) 30%, transparent) 0 2px, transparent 2px 7px); }
.lp-ring[data-kind='added'] .lp-ring-tag { background: var(--lp-add); color: #fff; }
.lp-ring[data-kind='removed'] .lp-ring-tag { background: var(--lp-del); color: #fff; bottom: auto; top: calc(100% + 4px); }
.lp-tick { background: var(--lp-muted); transition: background-color .2s; }
.lp-tick.is-on { background: var(--lp-tick-on); width: 3px; height: 16px; }
.lp-tick.is-on[data-kind='added'] { background: var(--lp-add); }
.lp-tick.is-on[data-kind='removed'] { background: var(--lp-del); }
.lp-wipe { -webkit-appearance: none; appearance: none; height: 44px; margin: 0; background: transparent; cursor: ew-resize; }
.lp-wipe::-webkit-slider-runnable-track { height: 44px; background: transparent; }
.lp-wipe::-moz-range-track { height: 44px; background: transparent; }
.lp-wipe::-webkit-slider-thumb { -webkit-appearance: none; width: 26px; height: 26px; margin-top: 9px; border-radius: 50%;
  background: var(--lp-accent); border: 2px solid var(--lp-edge); box-shadow: 0 0 0 4px var(--lp-paper); }
.lp-wipe::-moz-range-thumb { width: 22px; height: 22px; border-radius: 50%; background: var(--lp-accent); border: 2px solid var(--lp-edge); box-shadow: 0 0 0 4px var(--lp-paper); }
.lp-wipe:focus-visible { outline: none; }
.lp-wipe:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--lp-paper), 0 0 0 6px var(--lp-ink); }
.lp-wipe:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px var(--lp-paper), 0 0 0 6px var(--lp-ink); }

/* Itemised changes */
.lp-cell { display: flex; flex-direction: column; justify-content: flex-start; width: 100%; height: 100%; padding: 22px 22px 26px; text-align: left; color: var(--lp-muted);
  background: transparent; cursor: pointer; transition: background-color .3s var(--ease-route), color .3s var(--ease-route); }
.lp-cell:hover { background: color-mix(in srgb, var(--lp-ink) 4%, transparent); }
.lp-cell.is-on { color: var(--lp-ink); }
.lp-kind { display: inline-flex; align-items: center; gap: 8px; }
.lp-kind::before { content: ''; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--lp-muted); transition: all .3s var(--ease-route); }
.lp-cell.is-on .lp-kind::before { background: var(--lp-accent); border-color: var(--lp-accent); }
.lp-cell.is-on[data-kind='added'] .lp-kind::before { background: var(--lp-add); border-color: var(--lp-add); }
.lp-cell.is-on[data-kind='removed'] .lp-kind::before { background: var(--lp-del); border-color: var(--lp-del); }

/* Push rows */
.lp-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 24px; padding: 26px 4px 26px 18px; color: var(--lp-ink); text-decoration: none; align-items: baseline; }
.lp-row > :nth-child(2) { grid-column: 1; }
.lp-row > .lp-row-arrow { grid-column: 2; grid-row: 1; }
.lp-row::before { content: ''; position: absolute; left: 0; top: 22px; bottom: 22px; width: 3px; background: var(--lp-accent); transform: scaleY(0); transform-origin: top; transition: transform .35s var(--ease-route); }
.lp-row[data-active]::before { transform: scaleY(1); }
.lp-row-title { font-size: clamp(1.3rem, 1.1rem + .8vw, 1.75rem); font-weight: 500; line-height: 1.15; letter-spacing: -0.025em; }
.lp-row:not([data-active]) .lp-row-title { color: var(--lp-muted); }
.lp-shot { position: relative; }
.lp-shot-frame { border: 1px solid var(--lp-line); border-radius: 8px; overflow: hidden; background: var(--pcb-canvas); box-shadow: 0 30px 60px -40px rgba(0,0,0,.45); }
.lp-shot-frame:not([data-on]) { position: absolute; inset: 0 0 auto 0; opacity: 0; pointer-events: none; }
.lp-shot-frame { transition: opacity .35s var(--ease-route); }
.lp-shot-frame img { display: block; width: 100%; height: auto; }
.lp-shot-dark { display: none !important; }
:root[data-theme='dark'] .lp-shot-light { display: none !important; }
:root[data-theme='dark'] .lp-shot-dark { display: block !important; }
.lp-row-arrow { color: var(--lp-muted); transition: color .25s, translate .3s var(--ease-route); }
.lp-row:hover .lp-row-arrow { color: var(--lp-accent-ink); translate: 3px -3px; }

/* Close: a field of the accent colour, ink on top. */
.lp-close { --lp-ink: #121314; --lp-paper: #f1f2ef; --lp-muted: #3d3f42; background: var(--lp-accent); color: var(--lp-ink); }
.lp-cta-ink { background: var(--lp-ink); color: var(--lp-accent); }
.lp-cta-ink:hover { background: var(--lp-paper); color: var(--lp-ink); }
.lp-close :focus-visible { outline-color: var(--lp-ink); }
.lp-steps { position: relative; display: grid; gap: 48px; }
@media (min-width: 900px) {
  .lp-steps { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 40px; }
  .lp-steps::before { content: ''; position: absolute; left: 0; right: 0; top: 13px; height: 2px; background: var(--lp-ink); }
}
.lp-step { position: relative; display: flex; flex-direction: column; }
.lp-step-node { display: none; }
@media (min-width: 900px) { .lp-step-node { position: relative; display: flex; align-items: center; height: 28px; margin-bottom: 28px; } }
.lp-step-tick { display: block; width: 3px; height: 18px; background: var(--lp-ink); }
.lp-step-handle { display: block; width: 28px; height: 28px; border-radius: 50%; background: var(--lp-ink); box-shadow: 0 0 0 5px var(--lp-accent); }
@media (min-width: 900px) { .lp-step:last-child .lp-step-node { justify-content: flex-end; } }
.lp-step-title { margin-top: 14px; font-size: clamp(2.5rem, 1.3rem + 3.2vw, 4.5rem); font-weight: 500; line-height: .98; letter-spacing: -0.035em; }

@media (prefers-reduced-motion: reduce) {
  .lp-ring { transform: none; }
}
`;

type Context = { kind: 'user' | 'org'; slug: string; name: string; role?: 'owner' | 'member' };

const CONTEXT_KEY = 'jumper-workbench-context';

/** Signed-in home: your repositories (or an organization's), how to get the first board online, and what is new. */
export function HomePage() {
  const { data: me, isLoading } = useMe();
  const [ctxSlug, setCtxSlug] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CONTEXT_KEY);
    } catch {
      return null;
    }
  });
  const mine = useQuery({ queryKey: ['repos', 'mine'], queryFn: () => api.get<RepoInfo[]>('/repos', { mine: true }), enabled: Boolean(me) });
  const recent = useQuery({ queryKey: ['repos', 'explore', ''], queryFn: () => api.get<RepoInfo[]>('/repos'), enabled: Boolean(me) });
  const following = useQuery({
    queryKey: ['people', me?.username.toLowerCase() ?? '', 'following'],
    queryFn: () => api.get<FollowList>(`/users/${encodeURIComponent(me!.username)}/following`),
    enabled: Boolean(me),
  });
  const [filter, setFilter] = useState('');

  // Visitors who were not signed in last time get the landing at once instead of waiting on /auth/me.
  if (isLoading && wasSignedIn()) return <PageSpinner />;
  if (!me) return <Landing />;

  const contexts: Context[] = [{ kind: 'user', slug: me.username, name: me.name || me.username }, ...me.orgs.map((o) => ({ kind: 'org' as const, slug: o.slug, name: o.name || o.slug, role: o.role }))];
  const context = contexts.find((c) => c.slug.toLowerCase() === ctxSlug?.toLowerCase()) ?? contexts[0]!;
  const choose = (slug: string) => {
    setCtxSlug(slug);
    try {
      localStorage.setItem(CONTEXT_KEY, slug);
    } catch {
      /* the choice just will not survive a reload */
    }
  };
  const repos = (mine.data ?? []).filter((r) => r.owner.toLowerCase() === context.slug.toLowerCase());
  const shown = filter ? repos.filter((r) => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : repos;
  const empty = mine.isSuccess && repos.length === 0;
  const others = (recent.data ?? []).filter((r) => r.owner.toLowerCase() !== context.slug.toLowerCase()).slice(0, 6);

  return (
    <PageContainer className="max-w-[1280px] py-10 md:py-12">
      <header className="mb-10 flex flex-wrap items-end justify-between gap-x-6 gap-y-5">
        <div className="min-w-0">
          <h1 className="headline text-[clamp(2rem,1.4rem+1.6vw,2.75rem)]">Workbench</h1>
          {contexts.length > 1 ? (
            <div role="radiogroup" aria-label="Show the workbench for" className="mt-4 flex flex-wrap gap-1.5">
              {contexts.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  role="radio"
                  aria-checked={c.slug === context.slug}
                  onClick={() => choose(c.slug)}
                  className="inline-flex h-8 items-center gap-2 rounded-sm border border-border px-2.5 text-[13px] text-fg-muted transition-colors hover:text-fg aria-checked:border-select aria-checked:text-fg"
                >
                  <Avatar name={c.slug} size={16} square={c.kind === 'org'} />
                  {c.kind === 'user' ? 'Personal' : c.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[15px] text-fg-muted">Your boards, and what is new on Jumper.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {context.kind === 'org' && (
            <>
              <Link to="/$owner" params={{ owner: context.slug }} className={buttonClass('default', 'md')}>
                Profile
              </Link>
              {context.role === 'owner' && (
                <Link to="/organizations/$org/settings" params={{ org: context.slug }} className={buttonClass('default', 'md')}>
                  Settings
                </Link>
              )}
            </>
          )}
          <Link to="/new" search={{ owner: context.slug }} className={buttonClass('accent', 'md')}>
            <Plus size={15} aria-hidden /> New repository
          </Link>
        </div>
      </header>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <section aria-labelledby="mine-h" className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-3 pb-3">
            <h2 id="mine-h" className="flex items-baseline gap-3 text-lg font-medium">
              {context.kind === 'user' ? 'Your repositories' : `${context.name} repositories`}
              <span className="text-[13px] font-normal tabular-nums text-fg-muted">{mine.isSuccess ? repos.length : ''}</span>
            </h2>
            {repos.length > 5 && (
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Find a repository"
                aria-label="Find a repository"
                className="h-8 w-56 rounded-sm border border-border bg-canvas px-2.5 text-[13px] placeholder:text-fg-subtle focus:border-select focus:outline-none"
              />
            )}
          </div>
          {mine.isLoading ? (
            <PageSpinner />
          ) : empty ? (
            <FirstBoard org={context.kind === 'org' ? context.slug : undefined} />
          ) : (
            <RepoList repos={shown} showOwner={false} empty={`Nothing matches “${filter}”.`} />
          )}
        </section>

        <aside className="flex flex-col gap-10">
          <section aria-labelledby="follow-h">
            <h2 id="follow-h" className="mb-3 border-b border-border pb-3 text-[15px] font-medium">
              People you follow
            </h2>
            {following.data?.users.length ? (
              <ul className="flex flex-col gap-1">
                {following.data.users.slice(0, 8).map((u) => (
                  <li key={u.id}>
                    <Link to="/$owner" params={{ owner: u.username }} className="-mx-2 flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm no-underline hover:bg-canvas-subtle">
                      <Avatar name={u.username} src={u.avatarUrl} size={22} />
                      <span className="min-w-0 truncate font-medium text-fg">{u.name || u.username}</span>
                      {u.name && <span className="min-w-0 truncate text-fg-subtle">{u.username}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] leading-relaxed text-fg-muted">
                Follow designers from their profile to keep them here.{' '}
                <Link to="/explore" search={{ q: '' }} className="link">
                  Find some on Explore
                </Link>
                .
              </p>
            )}
          </section>

          <section aria-labelledby="recent-h">
            <div className="mb-3 flex items-baseline justify-between border-b border-border pb-3">
              <h2 id="recent-h" className="text-[15px] font-medium">
                New on Jumper
              </h2>
              <Link to="/explore" search={{ q: '' }} className="text-[13px] text-fg-muted no-underline hover:text-fg">
                Explore
              </Link>
            </div>
            {recent.isLoading ? (
              <PageSpinner />
            ) : others.length ? (
              <ul className="flex flex-col gap-3">
                {others.map((r) => (
                  <li key={r.id}>
                    <Link to="/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="group flex items-center gap-3 no-underline">
                      <RepoThumb repo={r} className="aspect-[16/10] w-16 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-fg group-hover:underline group-hover:decoration-fg/40 group-hover:underline-offset-4">
                          <span className="text-fg-muted">{r.owner} / </span>
                          <span className="font-medium">{r.name}</span>
                        </span>
                        <span className="block text-xs text-fg-subtle">
                          Updated <RelativeTime date={r.pushedAt ?? r.updatedAt} />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg-muted">Nothing new yet.</p>
            )}
          </section>
        </aside>
      </div>
    </PageContainer>
  );
}

/** Empty workbench: the three steps to a first board online, for you or for an organization. */
function FirstBoard({ org }: { org?: string }) {
  const steps = [
    { t: 'Create a repository', d: 'One per board or product. Start empty, from a starter template, or import an existing git repository.', to: '/new', cta: 'New repository' },
    { t: 'Create an access token', d: 'Git over HTTPS uses a token as the password. SSH keys and the KiCad plugin work too.', to: '/settings/tokens', cta: 'Create token' },
    { t: 'Push your KiCad project', d: 'Then open the repository to see the schematic, the board, its checks and its BOM.', to: '/docs/quick-start', cta: 'Read the guide' },
  ];
  return (
    <ol className="border-y border-border">
      {steps.map((x, i) => (
        <li key={x.t} className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border-muted py-5 last:border-b-0">
          <span className="w-6 font-mono text-sm tabular-nums text-fg-subtle">{i + 1}</span>
          <div className="min-w-0 flex-1 basis-64">
            <div className="font-medium">{x.t}</div>
            <div className="mt-1 text-sm leading-relaxed text-fg-muted">{x.d}</div>
          </div>
          {i === 0 ? (
            <Link to="/new" search={org ? { owner: org } : {}} className={buttonClass('primary', 'sm')}>
              {x.cta}
            </Link>
          ) : (
            <Link to={x.to} className={buttonClass('default', 'sm')}>
              {x.cta}
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
