import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

export interface StoredObject {
  body: Readable;
  size: number;
  contentType: string | null;
}

export interface Storage {
  put(key: string, body: Buffer | Readable, contentType: string, size?: number): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<void>;
  ensureReady(): Promise<void>;
}

/** Keys are always built by the platform, but never let them escape the root. */
function assertKey(key: string): void {
  if (!key || key.startsWith('/') || key.split('/').some((s) => s === '..' || s === '') || key.includes('\0')) {
    throw new Error(`invalid storage key: ${key}`);
  }
}

export class FsStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid storage key: ${key}`);
    return p;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const src = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    await pipeline(src, createWriteStream(p));
    // Content type is derived from the key's extension on read.
    void contentType;
  }

  async get(key: string): Promise<StoredObject | null> {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { body: createReadStream(p), size: s.size, contentType: null };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.path(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: Boolean(cfg.endpoint),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async ensureReady(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Buffer | Readable, contentType: string, size?: number): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: Buffer.isBuffer(body) ? body.length : size,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    assertKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: res.Body as Readable,
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
      };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (list.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  if ((env.STORAGE_DRIVER ?? 'fs') === 's3') {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION ?? 'us-east-1',
      bucket: env.S3_BUCKET ?? 'pcbhub',
      accessKeyId: env.S3_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_SECRET_KEY ?? '',
    });
  }
  return new FsStorage(resolveFromWorkspace(env.STORAGE_FS_ROOT ?? './data/artifacts'));
}

/**
 * Relative roots resolve against the monorepo root (like REPOS_DIR), so the api
 * and worker share one directory regardless of their working directory.
 */
export function resolveFromWorkspace(p: string): string {
  if (isAbsolute(p)) return p;
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return resolve(dir, p);
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd(), p);
    dir = parent;
  }
}

const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  glb: 'model/gltf-binary',
  step: 'model/step',
  stp: 'model/step',
  zip: 'application/zip',
  txt: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  xml: 'application/xml; charset=utf-8',
  net: 'text/plain; charset=utf-8',
  rpt: 'text/plain; charset=utf-8',
  drl: 'text/plain; charset=utf-8',
  gbr: 'text/plain; charset=utf-8',
  gbrjob: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}

export function artifactKey(repoId: string, sha: string, projectPath: string, name: string): string {
  const project = projectPath ? projectPath.replace(/[^a-zA-Z0-9._/-]/g, '_') : '_root';
  return `repos/${repoId}/${sha}/${project}/${name}`;
}
