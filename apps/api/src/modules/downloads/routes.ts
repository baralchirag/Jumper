// Downloads served by the instance itself, so self-hosted users get tools that match their server version.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import yazl from 'yazl';
import { workspaceRoot } from '@jumper/shared/node';
import { notFound } from '../../lib/errors';

/** The plugin source: the monorepo checkout in development, `/app/plugins` beside `dist` in Docker. */
function pluginDir(): string | null {
  const candidates = [join(workspaceRoot(), 'plugins/kicad/jumper'), fileURLToPath(new URL('../plugins/kicad/jumper', import.meta.url))];
  return candidates.find((c) => existsSync(join(c, 'metadata.json'))) ?? null;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out.sort();
}

let cached: { version: string; zip: Buffer } | null = null;

type PluginMeta = { versions: { version: string }[]; author: { name: string; contact: Record<string, string> }; resources: Record<string, string> };

/**
 * The KiCad plugin as a PCM package (Plugin and Content Manager → Install from File). Built once per process.
 * The metadata gets this server's own links, so KiCad's package page points back here.
 */
export async function kicadPluginZip(publicUrl: string): Promise<{ version: string; zip: Buffer } | null> {
  if (cached) return cached;
  const dir = pluginDir();
  if (!dir) return null;
  const meta = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as PluginMeta;
  const base = publicUrl.replace(/\/$/, '');
  meta.author.contact = { ...meta.author.contact, web: base };
  meta.resources = { ...meta.resources, Homepage: base, Documentation: `${base}/docs/kicad-plugin` };
  const zip = new yazl.ZipFile();
  for (const file of await walk(dir)) {
    const name = relative(dir, file).split('\\').join('/');
    const body = name === 'metadata.json' ? Buffer.from(`${JSON.stringify(meta, null, 2)}\n`) : await readFile(file);
    zip.addBuffer(body, name, { mtime: new Date(0) });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  cached = { version: meta.versions[0]!.version, zip: Buffer.concat(chunks) };
  return cached;
}

const downloadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/downloads/kicad-plugin', async () => {
    const p = await kicadPluginZip(app.ctx.env.PUBLIC_URL);
    if (!p) throw notFound('The KiCad plugin is not bundled with this server');
    return { version: p.version, size: p.zip.length, url: '/api/downloads/kicad-plugin.zip' };
  });
  app.get('/downloads/kicad-plugin.zip', async (_req, reply) => {
    const p = await kicadPluginZip(app.ctx.env.PUBLIC_URL);
    if (!p) throw notFound('The KiCad plugin is not bundled with this server');
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="jumper-kicad-${p.version}.zip"`)
      .header('Cache-Control', 'public, max-age=3600')
      .send(p.zip);
  });
};

export default downloadRoutes;
