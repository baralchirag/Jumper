import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Redis } from 'ioredis';
import yazl from 'yazl';
import { artifacts, checkRuns, eq, repositories, type Database } from '@pcbhub/db';
import type { KicadCore, Pcb } from '@pcbhub/kicad-core/node';
import {
  EVENTS_CHANNEL,
  parsePcbhubConfig,
  type AnalyzeCommitJob,
  type ArtifactKind,
  type CheckConclusion,
  type CheckDetails,
  type CheckName,
  type CheckStatus,
  type PcbhubConfig,
  type PlatformEvent,
} from '@pcbhub/shared';
import { artifactKey, contentTypeFor, type Storage } from '@pcbhub/storage';
import { discoverProjects, type Project } from './discover';
import type { WorkerEnv } from './env';
import * as git from './git';
import { describeFailure, KicadCli } from './kicad-cli';
import { log } from './log';
import { evaluateDrc, evaluateErc } from './reports';

const COPPER_KINDS = new Set(['signal', 'power', 'mixed', 'jumper']);
const VIEW_LAYERS = ['F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'F.Paste', 'B.Paste', 'Edge.Cuts', 'F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd', 'User.Drawings', 'User.Comments'];

interface StepResult {
  conclusion: CheckConclusion;
  summary: string;
  details?: CheckDetails;
}

class Deadline extends Error {}

export interface AnalyzerDeps {
  env: WorkerEnv;
  db: Database;
  redis: Redis;
  storage: Storage;
  kicad: KicadCore;
}

export class Analyzer {
  private readonly cli: KicadCli;

  constructor(private readonly deps: AnalyzerDeps) {
    this.cli = new KicadCli(deps.env);
  }

  private async publish(event: PlatformEvent): Promise<void> {
    await this.deps.redis.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch(() => {});
  }

  private async setCheck(
    job: AnalyzeCommitJob,
    name: CheckName,
    projectPath: string,
    status: CheckStatus,
    result?: Partial<StepResult>,
  ): Promise<void> {
    const now = new Date();
    const values = {
      repoId: job.repoId,
      sha: job.sha,
      name,
      projectPath,
      status,
      conclusion: status === 'completed' ? (result?.conclusion ?? 'neutral') : null,
      summary: result?.summary ?? null,
      details: result?.details ?? null,
      startedAt: status === 'queued' ? null : now,
      completedAt: status === 'completed' ? now : null,
    };
    const set: Partial<typeof values> = { status, conclusion: values.conclusion, summary: values.summary, details: values.details, completedAt: values.completedAt };
    if (status === 'in_progress' || status === 'queued') set.startedAt = values.startedAt;
    await this.deps.db
      .insert(checkRuns)
      .values(values)
      .onConflictDoUpdate({ target: [checkRuns.repoId, checkRuns.sha, checkRuns.name, checkRuns.projectPath], set });
    await this.publish({ type: 'check', repoId: job.repoId, sha: job.sha, name, projectPath, status, conclusion: values.conclusion });
  }

  private async addArtifact(
    job: AnalyzeCommitJob,
    projectPath: string,
    kind: ArtifactKind,
    name: string,
    file: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    const size = (await stat(file)).size;
    const key = artifactKey(job.repoId, job.sha, projectPath, `${kind}/${name}`);
    const contentType = contentTypeFor(name);
    await this.deps.storage.put(key, createReadStream(file), contentType, size);
    await this.deps.db
      .insert(artifacts)
      .values({ repoId: job.repoId, sha: job.sha, projectPath, kind, name, storageKey: key, contentType, size, meta })
      .onConflictDoUpdate({
        target: [artifacts.repoId, artifacts.sha, artifacts.projectPath, artifacts.kind, artifacts.name],
        set: { storageKey: key, contentType, size, meta, createdAt: new Date() },
      });
  }

  async run(job: AnalyzeCommitJob): Promise<void> {
    const { env } = this.deps;
    const repoRow = (await this.deps.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.id, job.repoId)).limit(1))[0];
    if (!repoRow) {
      log.info('repository gone, skipping', { ...job });
      return;
    }
    const repo = git.repoPath(env.reposDir, job.repoId);
    const deadline = Date.now() + env.WORKER_JOB_TIMEOUT_MS;

    const cfgText = await git.readFile(repo, job.sha, '.pcbhub.yml', 256 * 1024);
    const { config, error: configError } = parsePcbhubConfig(cfgText);
    const files = await git.listFiles(repo, job.sha);
    const projects = discoverProjects(
      files.map((f) => f.path),
      config.projects,
    );

    if (!projects.length) {
      const summary = configError ? `Invalid .pcbhub.yml: ${configError}` : 'No KiCad project found in this commit';
      for (const name of ['ERC', 'DRC', 'BOM', 'Render', 'Exports'] as CheckName[]) {
        await this.setCheck(job, name, '', 'completed', { conclusion: configError ? 'failure' : 'skipped', summary });
      }
      return;
    }

    const plan = (p: Project): [CheckName, boolean][] => [
      ['ERC', Boolean(p.schematic) && config.checks.erc.enabled],
      ['DRC', Boolean(p.board) && config.checks.drc.enabled],
      ['BOM', Boolean(p.schematic) && config.checks.bom.enabled],
      ['Render', config.outputs.svg],
      ['Exports', Boolean(p.board) && (config.outputs.glb || config.outputs.step || config.outputs.gerbers)],
    ];
    for (const p of projects) {
      for (const [name, enabled] of plan(p)) {
        await this.setCheck(job, name, p.path, enabled ? 'queued' : 'completed', enabled ? undefined : { conclusion: 'skipped', summary: 'Not applicable or disabled in .pcbhub.yml' });
      }
    }

    const work = await mkdtemp(join(tmpdir(), 'pcbhub-job-'));
    await chmod(work, 0o755);
    try {
      await git.checkout(repo, job.sha, join(work, 'src'), env.WORKER_MAX_CHECKOUT_BYTES);
      const version = await this.cli.version(work);
      log.info('analyzing', { ...job, projects: projects.length, kicad: version });

      for (const [i, p] of projects.entries()) {
        const out = join(work, 'out', String(i));
        await mkdir(out, { recursive: true, mode: 0o777 });
        await chmod(out, 0o777);
        for (const [name, enabled] of plan(p)) {
          if (!enabled) continue;
          await this.setCheck(job, name, p.path, 'in_progress');
          let result: StepResult;
          try {
            if (Date.now() > deadline) throw new Deadline();
            result = await this.step(name, job, p, config, work, out, version);
            if (name === 'Render' && configError) {
              result.summary += ` (.pcbhub.yml ignored: ${configError})`;
            }
          } catch (e) {
            if (e instanceof Deadline) result = { conclusion: 'timed_out', summary: 'Analysis exceeded the job time limit' };
            else {
              log.error('step failed', { ...job, step: name, project: p.path, error: String(e) });
              result = { conclusion: 'failure', summary: `Internal error: ${(e as Error).message}`.slice(0, 500) };
            }
          }
          await this.setCheck(job, name, p.path, 'completed', result);
        }
      }
    } catch (e) {
      // Setup failed: close out anything still pending so PRs don't hang.
      for (const p of projects) {
        for (const [name, enabled] of plan(p)) {
          if (!enabled) continue;
          await this.setCheck(job, name, p.path, 'completed', { conclusion: 'failure', summary: `Analysis failed: ${(e as Error).message}`.slice(0, 500) });
        }
      }
      throw e;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private step(name: CheckName, job: AnalyzeCommitJob, p: Project, config: PcbhubConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    switch (name) {
      case 'ERC':
        return this.erc(job, p, config, work, out, version);
      case 'DRC':
        return this.drc(job, p, config, work, out, version);
      case 'BOM':
        return this.bom(job, p, config, work, out);
      case 'Render':
        return this.render(job, p, work, out, version);
      case 'Exports':
        return this.exports(job, p, config, work, out, version);
    }
  }

  private noCli(): StepResult {
    return { conclusion: 'failure', summary: 'kicad-cli is not available on this worker' };
  }

  private rel(work: string, abs: string): string {
    return relative(work, abs);
  }

  private async erc(job: AnalyzeCommitJob, p: Project, config: PcbhubConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return this.noCli();
    const report = join(out, 'erc.json');
    const r = await this.cli.exec(['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', this.rel(work, report), `src/${p.schematic}`], work);
    const json = await readFile(report, 'utf8').catch(() => null);
    if (!json) return { conclusion: 'failure', summary: `ERC could not run (${describeFailure(r)})`, details: { log: r.stderr.slice(-4000) } };
    const ev = evaluateErc(JSON.parse(json), config);
    await this.addArtifact(job, p.path, 'erc_report', 'erc.json', report);
    return { conclusion: ev.conclusion, summary: ev.summary, details: { counts: ev.counts, annotations: ev.annotations, file: p.schematic, kicadVersion: version } };
  }

  private async drc(job: AnalyzeCommitJob, p: Project, config: PcbhubConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return this.noCli();
    const report = join(out, 'drc.json');
    const args = ['pcb', 'drc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', this.rel(work, report)];
    if (config.checks.drc.schematic_parity && p.schematic) args.push('--schematic-parity');
    args.push(`src/${p.board}`);
    const r = await this.cli.exec(args, work);
    const json = await readFile(report, 'utf8').catch(() => null);
    if (!json) return { conclusion: 'failure', summary: `DRC could not run (${describeFailure(r)})`, details: { log: r.stderr.slice(-4000) } };
    const ev = evaluateDrc(JSON.parse(json), config);
    await this.addArtifact(job, p.path, 'drc_report', 'drc.json', report);
    return { conclusion: ev.conclusion, summary: ev.summary, details: { counts: ev.counts, annotations: ev.annotations, file: p.board, kicadVersion: version } };
  }

  /** Root schematic plus referenced sub-sheets, read from a checkout dir or from git. */
  private async sheets(read: (path: string) => Promise<string | null>, root: string): Promise<string[]> {
    const dir = root.includes('/') ? root.slice(0, root.lastIndexOf('/') + 1) : '';
    const seen = new Set<string>();
    const queue = [root];
    const texts: string[] = [];
    while (queue.length && seen.size < 200) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const text = await read(path);
      if (!text) continue;
      texts.push(text);
      for (const m of text.matchAll(/\(property\s+"Sheet ?file"\s+"([^"]+)"/g)) {
        const rel = m[1]!.replace(/\\/g, '/');
        if (!rel.startsWith('/') && !rel.split('/').includes('..')) queue.push(dir + rel);
      }
    }
    return texts;
  }

  private async bom(job: AnalyzeCommitJob, p: Project, config: PcbhubConfig, work: string, out: string): Promise<StepResult> {
    const fromDisk = (path: string) => readFile(join(work, 'src', path), 'utf8').catch(() => null);
    const sheets = await this.sheets(fromDisk, p.schematic!);
    const lines = this.deps.kicad.bom(sheets);
    const jsonFile = join(out, 'bom.json');
    const csvFile = join(out, 'bom.csv');
    await writeFile(jsonFile, JSON.stringify(lines, null, 2));
    const extra = [...new Set(lines.flatMap((l) => Object.keys(l.fields)))].sort();
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [
      ['References', 'Quantity', 'Value', 'Footprint', 'DNP', ...extra].join(','),
      ...lines.map((l) => [l.references.join(' '), String(l.quantity), l.value, l.footprint, l.dnp ? 'DNP' : '', ...extra.map((k) => l.fields[k] ?? '')].map(esc).join(',')),
    ].join('\n');
    await writeFile(csvFile, csv + '\n');
    await this.addArtifact(job, p.path, 'bom', 'bom.json', jsonFile, { lines: lines.length });
    await this.addArtifact(job, p.path, 'bom', 'bom.csv', csvFile, { lines: lines.length });

    const parts = lines.filter((l) => !l.dnp).reduce((n, l) => n + l.quantity, 0);
    const summary = `${lines.length} line${lines.length === 1 ? '' : 's'}, ${parts} part${parts === 1 ? '' : 's'}`;

    const parent = (await git.parents(git.repoPath(this.deps.env.reposDir, job.repoId), job.sha))[0];
    if (!parent) return { conclusion: 'success', summary, details: { lines: lines.length, parts } };
    const repo = git.repoPath(this.deps.env.reposDir, job.repoId);
    const before = await this.sheets((path) => git.readFile(repo, parent, path), p.schematic!);
    const changes = before.length ? this.deps.kicad.bomDiff(before, sheets) : [];
    if (changes.length && config.checks.bom.block_on_change) {
      return { conclusion: 'failure', summary: `${summary}; BOM changed (${changes.length} line${changes.length === 1 ? '' : 's'}) and block_on_change is set`, details: { changes } };
    }
    return { conclusion: 'success', summary: changes.length ? `${summary}; ${changes.length} line(s) changed since parent` : summary, details: { lines: lines.length, parts, changes } };
  }

  private async render(job: AnalyzeCommitJob, p: Project, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return { conclusion: 'neutral', summary: 'kicad-cli unavailable; the interactive viewer still works' };
    const produced: string[] = [];
    const failures: string[] = [];

    if (p.schematic) {
      const dir = join(out, 'sch');
      await mkdir(dir, { recursive: true, mode: 0o777 });
      await chmod(dir, 0o777);
      const r = await this.cli.exec(['sch', 'export', 'svg', '-o', this.rel(work, dir), `src/${p.schematic}`], work);
      const svgs = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.svg')).sort((a, b) => a.length - b.length || a.localeCompare(b));
      if (!svgs.length) failures.push(`schematic (${describeFailure(r)})`);
      for (const [order, f] of svgs.entries()) {
        await this.addArtifact(job, p.path, 'sch_svg', f, join(dir, f), { order, sheet: f.replace(/\.svg$/, '') });
        produced.push(f);
      }
    }

    if (p.board) {
      const dir = join(out, 'pcb');
      await mkdir(dir, { recursive: true, mode: 0o777 });
      await chmod(dir, 0o777);
      const text = await readFile(join(work, 'src', p.board), 'utf8');
      let layers: string[] = ['F.Cu', 'B.Cu', ...VIEW_LAYERS];
      try {
        const parsed = this.deps.kicad.parse(text, 'pcb');
        const board = parsed.model as Pcb;
        const defined = new Set(board.layers.map((l) => l.name));
        const copper = board.layers.filter((l) => COPPER_KINDS.has(l.kind) && l.name.endsWith('.Cu')).map((l) => l.name);
        layers = [...copper, ...VIEW_LAYERS.filter((l) => defined.has(l))];
      } catch (e) {
        log.warn('board parse failed; using default layers', { error: String(e) });
      }
      const exportSvg = async (file: string, layerList: string, extra: string[] = []) => {
        const target = join(dir, file);
        const r = await this.cli.exec(
          ['pcb', 'export', 'svg', '--layers', layerList, '--exclude-drawing-sheet', '--page-size-mode', '2', ...extra, '-o', this.rel(work, target), `src/${p.board}`],
          work,
        );
        const ok = await stat(target).then((s) => s.size > 0, () => false);
        if (!ok) failures.push(`${layerList} (${describeFailure(r)})`);
        return ok ? target : null;
      };
      for (const [order, layer] of layers.entries()) {
        const f = await exportSvg(`${layer}.svg`, layer);
        if (f) {
          await this.addArtifact(job, p.path, 'pcb_svg', `${layer}.svg`, f, { layer, order });
          produced.push(layer);
        }
      }
      const top = await exportSvg('top.svg', 'F.Cu,F.SilkS,F.Mask,Edge.Cuts');
      if (top) await this.addArtifact(job, p.path, 'thumbnail', 'top.svg', top, { side: 'top' });
      const bottom = await exportSvg('bottom.svg', 'B.Cu,B.SilkS,B.Mask,Edge.Cuts', ['--mirror']);
      if (bottom) await this.addArtifact(job, p.path, 'thumbnail', 'bottom.svg', bottom, { side: 'bottom' });
    }

    const conclusion: CheckConclusion = failures.length === 0 ? 'success' : produced.length ? 'neutral' : 'failure';
    const summary = `${produced.length} view${produced.length === 1 ? '' : 's'} rendered${failures.length ? `, ${failures.length} failed` : ''}`;
    return { conclusion, summary, details: { produced, failures, kicadVersion: version } };
  }

  private async exports(job: AnalyzeCommitJob, p: Project, config: PcbhubConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return this.noCli();
    const board = `src/${p.board}`;
    const done: string[] = [];
    const failed: string[] = [];

    if (config.outputs.glb) {
      const target = join(out, 'board.glb');
      const r = await this.cli.exec(['pcb', 'export', 'glb', '--subst-models', '-f', '-o', this.rel(work, target), board], work);
      if (await stat(target).then((s) => s.size > 0, () => false)) {
        await this.addArtifact(job, p.path, 'glb', 'board.glb', target);
        done.push('GLB');
      } else failed.push(`GLB (${describeFailure(r)})`);
    }
    if (config.outputs.step) {
      const target = join(out, 'board.step');
      const r = await this.cli.exec(['pcb', 'export', 'step', '--subst-models', '-f', '-o', this.rel(work, target), board], work);
      if (await stat(target).then((s) => s.size > 0, () => false)) {
        await this.addArtifact(job, p.path, 'step', 'board.step', target);
        done.push('STEP');
      } else failed.push(`STEP (${describeFailure(r)})`);
    }
    if (config.outputs.gerbers) {
      const dir = join(out, 'gerbers');
      await mkdir(dir, { recursive: true, mode: 0o777 });
      await chmod(dir, 0o777);
      const g = await this.cli.exec(['pcb', 'export', 'gerbers', '-o', `${this.rel(work, dir)}/`, board], work);
      const d = await this.cli.exec(['pcb', 'export', 'drill', '-o', `${this.rel(work, dir)}/`, board], work);
      const names = (await readdir(dir).catch(() => [])).sort();
      if (names.length) {
        const zipFile = join(out, 'gerbers.zip');
        await zipDir(dir, names, zipFile);
        await this.addArtifact(job, p.path, 'gerbers', 'gerbers.zip', zipFile, { files: names });
        done.push('Gerbers');
      } else failed.push(`Gerbers (${describeFailure(g.code === 0 ? d : g)})`);
    }

    const conclusion: CheckConclusion = failed.length === 0 ? 'success' : done.length ? 'neutral' : 'failure';
    return { conclusion, summary: done.length ? `Generated ${done.join(', ')}${failed.length ? `; failed: ${failed.length}` : ''}` : 'No outputs generated', details: { done, failed } };
  }
}

function zipDir(dir: string, names: string[], target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const n of names) zip.addFile(join(dir, n), n);
    zip.outputStream.pipe(createWriteStream(target)).on('close', () => resolve()).on('error', reject);
    zip.end();
  });
}
