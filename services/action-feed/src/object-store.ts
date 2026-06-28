import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StoredObject {
  key: string;
  uri: string;
  bytes: number;
}

export interface ObjectStore {
  putJson(key: string, value: unknown): Promise<StoredObject>;
  getJson<T = unknown>(key: string): Promise<T>;
  getJsonByUri<T = unknown>(uri: string): Promise<T>;
}

export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, string>();

  async putJson(key: string, value: unknown): Promise<StoredObject> {
    const body = JSON.stringify(value);
    this.objects.set(key, body);
    return { key, uri: `memory://${key}`, bytes: Buffer.byteLength(body) };
  }

  async getJson<T = unknown>(key: string): Promise<T> {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`object not found: ${key}`);
    return JSON.parse(body) as T;
  }

  async getJsonByUri<T = unknown>(uri: string): Promise<T> {
    if (!uri.startsWith('memory://')) throw new Error(`unsupported memory object uri: ${uri}`);
    return this.getJson<T>(uri.slice('memory://'.length));
  }
}

export class FilesystemObjectStore implements ObjectStore {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async putJson(key: string, value: unknown): Promise<StoredObject> {
    const safeKey = sanitizeKey(key);
    const path = join(this.rootDir, safeKey);
    const body = JSON.stringify(value);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
    return { key: safeKey, uri: `file://${path}`, bytes: Buffer.byteLength(body) };
  }

  async getJson<T = unknown>(key: string): Promise<T> {
    const body = await readFile(join(this.rootDir, sanitizeKey(key)), 'utf8');
    return JSON.parse(body) as T;
  }

  async getJsonByUri<T = unknown>(uri: string): Promise<T> {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') throw new Error(`unsupported filesystem object uri: ${uri}`);
    const body = await readFile(fileURLToPath(parsed), 'utf8');
    return JSON.parse(body) as T;
  }
}

function sanitizeKey(key: string): string {
  return key
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}
