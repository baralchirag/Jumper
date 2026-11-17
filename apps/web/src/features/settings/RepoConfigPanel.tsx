import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FAB_CHOICES } from './fab-choices';
import { Button, Checkbox, Flash, FormField, PageSpinner, Textarea } from '@jumper/ui';
import { api, errorMessage, repoPath } from '../../shared/lib/api';
import { keys } from '../../shared/lib/queries';
import { useRepoInfo } from '../repo/context';

interface Config {
  /** Not edited here; round-tripped so saving never discards saved stackups. */
  stackups: Record<string, unknown>;
  fabProfiles: string[];
  checklistTemplate: string[];
  requireChecklist: boolean;
  partPolicy: {
    approvedManufacturers: string[];
    preferredParts: string[];
    bannedParts: { pattern: string; reason: string }[];
    bannedFootprints: { pattern: string; reason: string }[];
  };
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
/** "pattern | reason" per line. */
const parseBans = (s: string) => lines(s).map((l) => {
  const [pattern = '', ...rest] = l.split('|');
  return { pattern: pattern.trim(), reason: rest.join('|').trim() };
}).filter((b) => b.pattern);
const showBans = (b: { pattern: string; reason: string }[]) => b.map((x) => (x.reason ? `${x.pattern} | ${x.reason}` : x.pattern)).join('\n');

/** Review process and manufacturing policy for a repository. `section` picks which half to show. */
export function RepoConfigPanel({ section }: { section: 'review' | 'parts' }) {
  const info = useRepoInfo();
  const qc = useQueryClient();
  const key = [...keys.repo(info.owner, info.name), 'config'];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ config: Config }>(repoPath(info.owner, info.name, '/config')) });
  const [c, setC] = useState<Config | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (q.data) setC(q.data.config);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (cfg: Config) => {
      const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
      return api.put(repoPath(info.owner, info.name, '/config'), {
        ...cfg,
        checklistTemplate: clean(cfg.checklistTemplate),
        partPolicy: { ...cfg.partPolicy, approvedManufacturers: clean(cfg.partPolicy.approvedManufacturers), preferredParts: clean(cfg.partPolicy.preferredParts) },
      });
    },
    onSuccess: () => {
      setMsg({ tone: 'success', text: 'Saved.' });
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setMsg({ tone: 'danger', text: errorMessage(e) }),
  });
  if (!c) return <PageSpinner />;
  const set = (patch: Partial<Config>) => setC({ ...c, ...patch });
  const policy = (patch: Partial<Config['partPolicy']>) => set({ partPolicy: { ...c.partPolicy, ...patch } });
  return (
    <form
      className="max-w-2xl space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        save.mutate(c);
      }}
    >
      {msg && <Flash tone={msg.tone}>{msg.text}</Flash>}
      {section === 'review' ? (
        <>
          <FormField label="Review checklist template" hint="One item per line. Copied onto every pull request the first time it is opened, so reviewers confirm the same things every time (ERC clean, BOM checked, …).">
            {(id) => <Textarea id={id} rows={5} value={c.checklistTemplate.join('\n')} onChange={(e) => set({ checklistTemplate: e.target.value.split('\n') })} placeholder={'ERC and DRC are clean\nBOM and footprints checked\nPower budget reviewed'} />}
          </FormField>
          <Checkbox label="Require the checklist before merging" hint="Pull requests cannot be merged while a checklist item is unticked." checked={c.requireChecklist} onChange={(e) => set({ requireChecklist: e.target.checked })} />
        </>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">Target fabs</legend>
            <p className="text-xs text-fg-muted">Board analysis shows readiness for these fabs first. Leave all unticked to compare against every supported fab.</p>
            {FAB_CHOICES.map((f) => (
              <Checkbox key={f.id} label={f.name} checked={c.fabProfiles.includes(f.id)} onChange={(e) => set({ fabProfiles: e.target.checked ? [...c.fabProfiles, f.id] : c.fabProfiles.filter((x) => x !== f.id) })} />
            ))}
          </fieldset>
          <FormField label="Approved manufacturers" hint="One per line. When set, parts from other manufacturers are flagged. Leave empty to allow any.">
            {(id) => <Textarea id={id} rows={3} value={c.partPolicy.approvedManufacturers.join('\n')} onChange={(e) => policy({ approvedManufacturers: e.target.value.split('\n') })} placeholder={'Texas Instruments\nMurata'} />}
          </FormField>
          <FormField label="Preferred parts" hint="Manufacturer part numbers (wildcards allowed, e.g. GRM*). Reported as a count; never blocks.">
            {(id) => <Textarea id={id} rows={3} className="font-mono" value={c.partPolicy.preferredParts.join('\n')} onChange={(e) => policy({ preferredParts: e.target.value.split('\n') })} placeholder="GRM155*" />}
          </FormField>
          <FormField label="Banned parts" hint="One per line as “pattern | reason”. Matches the MPN or value; * and ? are wildcards.">
            {(id) => <Textarea id={id} rows={3} className="font-mono" value={showBans(c.partPolicy.bannedParts)} onChange={(e) => policy({ bannedParts: parseBans(e.target.value) })} placeholder="NE555* | obsolete, use TLC555" />}
          </FormField>
          <FormField label="Banned footprints" hint="Same format. Useful to keep hand-assembly feasible.">
            {(id) => <Textarea id={id} rows={2} className="font-mono" value={showBans(c.partPolicy.bannedFootprints)} onChange={(e) => policy({ bannedFootprints: parseBans(e.target.value) })} placeholder="*0201* | too small to hand-solder" />}
          </FormField>
        </>
      )}
      <Button type="submit" variant="primary" loading={save.isPending}>
        Save changes
      </Button>
    </form>
  );
}
