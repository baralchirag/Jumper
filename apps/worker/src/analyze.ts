import { optimizeKicadGlbOffThread } from './glb-thread';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Redis } from 'ioredis';
import yazl from 'yazl';
import { artifacts, checkRuns, eq, namespaces, repositories, type Database } from '@jumper/db';
import type { KicadCore, Pcb } from '@jumper/kicad-core/node';
import {
  CHECK_STAGES,
  EVENTS_CHANNEL,
  parseJumperConfig,
  type AnalyzeCommitJob,
  type ArtifactKind,
  type CheckConclusion,
  type CheckDetails,
  type CheckName,
  type CheckStage,
  type CheckStatus,
  type JumperConfig,
  type PlatformEvent,
  FAB_PACKAGE_LABELS,
} from '@jumper/shared';
import { artifactKey, contentTypeFor, type Storage } from '@jumper/storage';
import { discoverProjects, type Project } from './discover';
import type { WorkerEnv } from './env';
import * as git from './git';
import { describeFailure, KicadCli } from './kicad-cli';
import { log } from './log';
import type { BomLine } from '@jumper/kicad-core/node';
import { FAB_LAYOUTS, isFabFile, isNonPart } from './fab';
import { fixModelPaths } from './models3d';
import { libraryReport, librarySummary, sheetFiles, type LibraryReport } from './libraries';
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
    opts: { ifAbsent?: boolean } = {},
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
    const insert = this.deps.db.insert(checkRuns).values(values);
    if (opts.ifAbsent) {
      // Placeholder for the other lane's checks: never overwrite what that lane already wrote.
      const added = await insert.onConflictDoNothing().returning({ id: checkRuns.id });
      if (!added.length) return;
    } else {
      await insert.onConflictDoUpdate({ target: [checkRuns.repoId, checkRuns.sha, checkRuns.name, checkRuns.projectPath], set });
    }
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

  /**
   * Analyze one commit for one lane. `checks` runs ERC, DRC and BOM (fast); `outputs` runs renders and exports (slow).
   * The two lanes are separate jobs on separate queues, so review feedback never waits behind a STEP export.
   */
  async run(job: AnalyzeCommitJob, stage: CheckStage = 'checks'): Promise<void> {
    const { env } = this.deps;
    const mine = new Set<CheckName>(CHECK_STAGES[stage]);
    const repoRow = (
      await this.deps.db
        .select({ id: repositories.id, namespaceId: repositories.namespaceId, owner: namespaces.slug, defaultBranch: repositories.defaultBranch })
        .from(repositories)
        .innerJoin(namespaces, eq(namespaces.id, repositories.namespaceId))
        .where(eq(repositories.id, job.repoId))
        .limit(1)
    )[0];
    if (!repoRow) {
      log.info('repository gone, skipping', { ...job });
      return;
    }
    const repo = git.repoPath(env.reposDir, job.repoId);
    const deadline = Date.now() + env.WORKER_JOB_TIMEOUT_MS;

    const cfgText = await git.readFile(repo, job.sha, '.jumper.yml', 256 * 1024);
    const parsed = parseJumperConfig(cfgText);
    const configError = parsed.error;
    // Ray-traced renders are the heaviest step: high quality on the default branch (and manual re-runs, which have no
    // branch), basic elsewhere, unless .jumper.yml asks for one quality everywhere.
    const onDefault = !job.ref || job.ref === repoRow.defaultBranch;
    const config: JumperConfig = { ...parsed.config, outputs: { ...parsed.config.outputs, render_quality: parsed.config.outputs.render_quality ?? (onDefault ? 'high' : 'basic') } };
    const files = await git.listFiles(repo, job.sha);
    const projects = discoverProjects(
      files.map((f) => f.path),
      config.projects,
    );

    if (!projects.length) {
      // The checks lane reports for both lanes, so the commit says "no project" once.
      if (stage !== 'checks') return;
      const summary = configError ? `Invalid .jumper.yml: ${configError}` : 'No KiCad project found in this commit';
      for (const name of ['ERC', 'DRC', 'BOM', 'Render', 'Exports'] as CheckName[]) {
        await this.setCheck(job, name, '', 'completed', { conclusion: configError ? 'failure' : 'skipped', summary });
      }
      return;
    }

    const allChecks = (p: Project): [CheckName, boolean][] => [
      ['ERC', Boolean(p.schematic) && config.checks.erc.enabled],
      ['DRC', Boolean(p.board) && config.checks.drc.enabled],
      ['BOM', Boolean(p.schematic) && config.checks.bom.enabled],
      ['Render', config.outputs.svg || (Boolean(p.board) && config.outputs.render3d)],
      ['Exports', hasExports(p, config)],
    ];
    const plan = (p: Project) => allChecks(p).filter(([name]) => mine.has(name));
    for (const p of projects) {
      for (const [name, enabled] of allChecks(p)) {
        const state = enabled ? 'queued' : 'completed';
        const result = enabled ? undefined : { conclusion: 'skipped' as const, summary: 'Not applicable or disabled in .jumper.yml' };
        // Show the other lane's checks as queued too, without touching anything it has already written.
        await this.setCheck(job, name, p.path, state, result, { ifAbsent: !mine.has(name) });
      }
    }

    await mkdir(env.tmpDir, { recursive: true });
    const work = await mkdtemp(join(env.tmpDir, 'jumper-job-'));
    await chmod(work, 0o755);
    try {
      await git.checkout(repo, job.sha, join(work, 'src'), env.WORKER_MAX_CHECKOUT_BYTES);
      const version = await this.cli.version(work);
      log.info('analyzing', { ...job, projects: projects.length, kicad: version });

      for (const [i, p] of projects.entries()) {
        const out = join(work, 'out', String(i));
        await mkdir(out, { recursive: true, mode: 0o777 });
        await chmod(out, 0o777);
        const models = p.board && version ? await this.prepareBoard(p, work, files.map((f) => f.path)) : null;
        const libraries =
          stage === 'checks'
            ? await this.libraries(job, p, work, files.map((f) => f.path), models?.missing ?? []).catch((e) => {
                log.warn('library report failed', { ...job, project: p.path, error: String(e) });
                return null;
              })
            : null;
        for (const [name, enabled] of plan(p)) {
          if (!enabled) continue;
          await this.setCheck(job, name, p.path, 'in_progress');
          let result: StepResult;
          try {
            if (Date.now() > deadline) throw new Deadline();
            result = await this.step(name, job, p, config, work, out, version);
            if (models && (name === 'Exports' || name === 'Render') && result.details) result.details.models = models;
            if (libraries && (name === 'ERC' || name === 'DRC')) {
              const relevant = name === 'ERC' ? { ...libraries, footprints: [], missingModels: [] } : { ...libraries, symbols: [], missingSheets: [] };
              const line = librarySummary(relevant);
              result.details = { ...(result.details ?? {}), libraries: relevant };
              if (line) result.summary = `${result.summary} · ${line}`;
            }
            if (name === 'Render' && configError) {
              result.summary += ` (.jumper.yml ignored: ${configError})`;
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

  private step(name: CheckName, job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    switch (name) {
      case 'ERC':
        return this.erc(job, p, config, work, out, version);
      case 'DRC':
        return this.drc(job, p, config, work, out, version);
      case 'BOM':
        return this.bom(job, p, config, work, out);
      case 'Render':
        return this.render(job, p, config, work, out, version);
      case 'Exports':
        return this.exports(job, p, config, work, out, version);
    }
  }

  /**
   * Point footprint 3D models at the worker's KiCad library so GLB/STEP/renders
   * include component bodies. Only the scratch checkout is modified.
   */
  private async prepareBoard(p: Project, work: string, repoFiles: string[]): Promise<{ resolved: number; missing: string[] } | null> {
    const index = await this.cli.models();
    if (!index) return null;
    const file = join(work, 'src', p.board!);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (!text) return null;
    const prefix = p.dir ? `${p.dir}/` : '';
    const projectFiles = new Set(repoFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)));
    const r = fixModelPaths(text, index, projectFiles);
    if (r.fixed) await writeFile(file, r.text);
    return { resolved: r.fixed, missing: r.missing.slice(0, 50) };
  }

  /**
   * Libraries the project uses and which of them a fresh clone cannot find. Stored as an artifact and shown on the ERC
   * and DRC results, so "works on my machine" libraries are caught at the first push.
   */
  private async libraries(job: AnalyzeCommitJob, p: Project, work: string, repoFiles: string[], missingModels: string[]): Promise<LibraryReport | null> {
    if (!p.schematic && !p.board) return null;
    const read = (path: string) => readFile(join(work, 'src', path), 'utf8').catch(() => null);
    const schematics: { path: string; text: string }[] = [];
    if (p.schematic) {
      const seen = new Set<string>();
      const queue = [p.schematic];
      while (queue.length && seen.size < 200) {
        const path = queue.shift()!;
        if (seen.has(path)) continue;
        seen.add(path);
        const text = await read(path);
        if (!text) continue;
        schematics.push({ path, text });
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        for (const f of sheetFiles(text)) queue.push(`${dir}${f}`.replace(/\/\.\//g, '/'));
      }
    }
    const prefix = p.dir ? `${p.dir}/` : '';
    const std = await this.cli.standardLibraries();
    const report = libraryReport({
      projectDir: p.dir,
      schematics,
      board: p.board ? await read(p.board) : null,
      symLibTable: await read(`${prefix}sym-lib-table`),
      fpLibTable: await read(`${prefix}fp-lib-table`),
      repoFiles: new Set(repoFiles),
      standardSymbols: std.symbols,
      standardFootprints: std.footprints,
      missingModels,
    });
    const file = join(work, 'out', `libraries-${Buffer.from(p.path).toString('hex').slice(0, 32)}.json`);
    await writeFile(file, JSON.stringify(report, null, 2));
    await this.addArtifact(job, p.path, 'library_report', 'libraries.json', file, { problems: report.problems });
    return report;
  }

  private noCli(): StepResult {
    return { conclusion: 'failure', summary: 'kicad-cli is not available on this worker' };
  }

  private rel(work: string, abs: string): string {
    return relative(work, abs);
  }

  private async erc(job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return this.noCli();
    const report = join(out, 'erc.json');
    const r = await this.cli.exec(['sch', 'erc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', this.rel(work, report), `src/${p.schematic}`], work);
    const json = await readFile(report, 'utf8').catch(() => null);
    if (!json) return { conclusion: 'failure', summary: `ERC could not run (${describeFailure(r)})`, details: { log: r.stderr.slice(-4000) } };
    const ev = evaluateErc(JSON.parse(json), config);
    await this.addArtifact(job, p.path, 'erc_report', 'erc.json', report);
    return { conclusion: ev.conclusion, summary: ev.summary, details: { counts: ev.counts, annotations: ev.annotations, file: p.schematic, kicadVersion: version } };
  }

  private async drc(job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string, version: string | null): Promise<StepResult> {
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

  private async bom(job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string): Promise<StepResult> {
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

  private async render(job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return { conclusion: 'neutral', summary: 'kicad-cli unavailable; the interactive viewer still works' };
    const produced: string[] = [];
    const failures: string[] = [];

    if (p.board && config.outputs.render3d && (await this.cli.major(work)) >= 9) {
      const dir = join(out, 'render3d');
      await mkdir(dir, { recursive: true, mode: 0o777 });
      await chmod(dir, 0o777);
      const shots: { name: string; args: string[] }[] = [
        { name: 'top', args: ['--side', 'top'] },
        { name: 'bottom', args: ['--side', 'bottom'] },
        { name: 'iso-top', args: ['--side', 'top', '--rotate', '-35,0,-25', '--perspective', '--zoom', '0.9'] },
        { name: 'iso-bottom', args: ['--side', 'bottom', '--rotate', '-35,0,25', '--perspective', '--zoom', '0.9'] },
      ];
      for (const [order, shot] of shots.entries()) {
        const target = join(dir, `${shot.name}.png`);
        const r = await this.cli.exec(
          ['pcb', 'render', ...shot.args, '--quality', config.outputs.render_quality ?? 'high', '--background', 'opaque', '-w', '1600', '-h', '1000', '-o', this.rel(work, target), `src/${p.board}`],
          work,
        );
        if (await stat(target).then((st) => st.size > 0, () => false)) {
          await this.addArtifact(job, p.path, 'render3d', `${shot.name}.png`, target, { view: shot.name, order });
          produced.push(`3D ${shot.name}`);
        } else failures.push(`3D ${shot.name} (${describeFailure(r)})`);
      }
    }
    if (!config.outputs.svg) {
      const conclusion: CheckConclusion = failures.length === 0 ? 'success' : produced.length ? 'neutral' : 'failure';
      return { conclusion, summary: `${produced.length} view${produced.length === 1 ? '' : 's'} rendered${failures.length ? `, ${failures.length} failed` : ''}`, details: { produced, failures, kicadVersion: version } };
    }

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

  private async exports(job: AnalyzeCommitJob, p: Project, config: JumperConfig, work: string, out: string, version: string | null): Promise<StepResult> {
    if (!version) return this.noCli();
    const o = config.outputs;
    const board = p.board ? `src/${p.board}` : null;
    const sch = p.schematic ? `src/${p.schematic}` : null;
    const done: string[] = [];
    const failed: string[] = [];
    const exists = (f: string) => stat(f).then((st) => st.isFile() && st.size > 0, () => false);
    const mkdirOut = async (name: string) => {
      const dir = join(out, name);
      await mkdir(dir, { recursive: true, mode: 0o777 });
      await chmod(dir, 0o777);
      return dir;
    };
    /** Run one kicad-cli export that writes a single file. */
    const single = async (label: string, kind: ArtifactKind, file: string, args: string[], meta: Record<string, unknown> = {}) => {
      const target = join(out, file);
      const r = await this.cli.exec([...args.slice(0, -1), '-o', this.rel(work, target), args[args.length - 1]!], work);
      if (await exists(target)) {
        await this.addArtifact(job, p.path, kind, file, target, meta);
        done.push(label);
        return target;
      }
      failed.push(`${label} (${describeFailure(r)})`);
      return null;
    };

    if (board && o.glb) {
      // kicad-cli's export, then compressed for the browser (often 14 MB -> under 1 MB) with parts tagged for finishing.
      const target = join(out, 'board.glb');
      const r = await this.cli.exec(['pcb', 'export', 'glb', '--subst-models', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '-f', '-o', this.rel(work, target), board], work);
      if (await exists(target)) {
        const raw = await readFile(target);
        let meta: Record<string, unknown> = { rawBytes: raw.length };
        try {
          const small = await optimizeKicadGlbOffThread(raw);
          await writeFile(target, small);
          meta = { ...meta, compressed: true };
        } catch (e) {
          meta = { ...meta, compressed: false, compressError: (e as Error).message.slice(0, 200) };
        }
        await this.addArtifact(job, p.path, 'glb', 'board.glb', target, meta);
        done.push('GLB');
      } else {
        failed.push(`GLB (${describeFailure(r)})`);
      }
    }
    if (board && o.step) await single('STEP', 'step', 'board.step', ['pcb', 'export', 'step', '--subst-models', '-f', board]);

    let gerberDir: string | null = null;
    let gerberNames: string[] = [];
    if (board && (o.gerbers || o.fab_package.length > 0)) {
      const dir = await mkdirOut('gerbers');
      const g = await this.cli.exec(['pcb', 'export', 'gerbers', '-o', `${this.rel(work, dir)}/`, board], work);
      const d = await this.cli.exec(['pcb', 'export', 'drill', '--format', 'excellon', '--excellon-separate-th', '--generate-map', '--map-format', 'gerberx2', '-o', `${this.rel(work, dir)}/`, board], work);
      gerberNames = (await readdir(dir).catch(() => [])).filter(isFabFile).sort();
      if (gerberNames.length) {
        gerberDir = dir;
        if (o.gerbers) {
          const zipFile = join(out, 'gerbers.zip');
          await zipFiles(gerberNames.map((n) => [join(dir, n), n]), zipFile);
          await this.addArtifact(job, p.path, 'gerbers', 'gerbers.zip', zipFile, { files: gerberNames });
          done.push('Gerbers');
        }
      } else failed.push(`Gerbers (${describeFailure(g.code === 0 ? d : g)})`);
    }

    let posFile: string | null = null;
    if (board && (o.pos || o.fab_package.length > 0)) {
      posFile = o.pos
        ? await single('Pick-and-place', 'pos', 'positions.csv', ['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both', '--exclude-dnp', board])
        : await (async () => {
            const target = join(out, 'positions.csv');
            await this.cli.exec(['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both', '--exclude-dnp', '-o', this.rel(work, target), board], work);
            return (await exists(target)) ? target : null;
          })();
    }

    if (o.pdf) {
      if (sch) await single('Schematic PDF', 'pdf', 'schematic.pdf', ['sch', 'export', 'pdf', sch], { source: 'schematic' });
      if (board && (await this.cli.major(work)) < 9) {
        await single('Board PDF', 'pdf', 'board.pdf', ['pcb', 'export', 'pdf', '--layers', 'F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts', board], { source: 'board' });
      } else if (board) {
        // Multi-page mode treats -o as a directory and names the file after the board.
        const dir = await mkdirOut('board-pdf');
        const layers = 'F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts,F.Fab,B.Fab';
        const r = await this.cli.exec(['pcb', 'export', 'pdf', '--layers', layers, '--mode-multipage', '--include-border-title', '-o', `${this.rel(work, dir)}/`, board], work);
        const pdf = (await readdir(dir).catch(() => [])).find((f) => f.endsWith('.pdf'));
        if (pdf) {
          await this.addArtifact(job, p.path, 'pdf', 'board.pdf', join(dir, pdf), { source: 'board' });
          done.push('Board PDF');
        } else failed.push(`Board PDF (${describeFailure(r)})`);
      }
    }
    if (sch && o.netlist) await single('Netlist', 'netlist', 'netlist.net', ['sch', 'export', 'netlist', '--format', 'kicadsexpr', sch]);
    if (board && o.ipc2581) await single('IPC-2581', 'ipc2581', 'board-ipc2581.xml', ['pcb', 'export', 'ipc2581', '--units', 'mm', board]);
    if (board && o.odb) await single('ODB++', 'odb', 'board-odb.zip', ['pcb', 'export', 'odb', '--compression', 'zip', board]);

    if (board && o.fab_package.length > 0 && gerberDir) {
      let lines: BomLine[] | null = null;
      const nonParts = new Set<string>();
      if (p.schematic) {
        const sheets = await this.sheets((path) => readFile(join(work, 'src', path), 'utf8').catch(() => null), p.schematic);
        try {
          lines = this.deps.kicad.bom(sheets);
          for (const l of lines) if (isNonPart(l)) for (const r of l.references) nonParts.add(r);
        } catch (e) {
          failed.push(`Fab BOM (${(e as Error).message})`);
        }
      }
      const posCsv = posFile ? await readFile(posFile, 'utf8') : null;
      // One zip per fab house, each laid out the way that fab's upload form expects.
      for (const format of o.fab_package) {
        const layout = FAB_LAYOUTS[format];
        const entries: [string, string][] = gerberNames.map((n) => [join(gerberDir!, n), `${layout.gerberDir}${n}`]);
        const extra: string[] = [];
        if (lines && layout.bom) {
          const bomFile = join(out, `fab-bom-${format}.csv`);
          await writeFile(bomFile, layout.bom.build(lines));
          entries.push([bomFile, layout.bom.name]);
          extra.push('BOM');
        }
        if (posCsv && layout.cpl) {
          const cpl = join(out, `fab-cpl-${format}.csv`);
          await writeFile(cpl, layout.cpl.build(posCsv, nonParts));
          entries.push([cpl, layout.cpl.name]);
          extra.push('CPL');
        }
        const zipFile = join(out, `fab-${format}.zip`);
        const name = `${p.name}-${format}-${job.sha.slice(0, 7)}.zip`;
        await zipFiles(entries, zipFile);
        await this.addArtifact(job, p.path, 'fab_package', name, zipFile, { format, files: entries.map(([, n]) => n) });
        done.push(`${FAB_PACKAGE_LABELS[format]} package${extra.length ? ` (gerbers + ${extra.join(' + ')})` : ''}`);
      }
    }

    const conclusion: CheckConclusion = failed.length === 0 ? 'success' : done.length ? 'neutral' : 'failure';
    return { conclusion, summary: done.length ? `Generated ${done.join(', ')}${failed.length ? `; failed: ${failed.length}` : ''}` : 'No outputs generated', details: { done, failed, kicadVersion: version } };
  }
}

function hasExports(p: Project, config: JumperConfig): boolean {
  const o = config.outputs;
  const boardOut = o.glb || o.step || o.gerbers || o.pos || o.pdf || o.ipc2581 || o.odb || o.fab_package.length > 0;
  const schOut = o.pdf || o.netlist;
  return (Boolean(p.board) && boardOut) || (Boolean(p.schematic) && schOut);
}

function zipFiles(entries: [string, string][], target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [file, name] of entries) zip.addFile(file, name);
    zip.outputStream.pipe(createWriteStream(target)).on('close', () => resolve()).on('error', reject);
    zip.end();
  });
}
