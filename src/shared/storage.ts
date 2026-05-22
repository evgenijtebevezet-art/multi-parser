import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { env } from './env.js';
import { log } from './logger.js';

export interface StorageBackend {
  upload(localPath: string, key: string): Promise<{ id: string; pathOrUri: string }>;
  exists(key: string): Promise<boolean>;
  downloadTo(key: string, dest: string): Promise<void>;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

class LocalFsBackend implements StorageBackend {
  constructor(private readonly root: string) {
    ensureDir(this.root);
  }

  private fullPath(key: string): string {
    return resolvePath(join(this.root, key));
  }

  async upload(localPath: string, key: string): Promise<{ id: string; pathOrUri: string }> {
    const dest = this.fullPath(key);
    ensureDir(dirname(dest));
    if (resolvePath(localPath) !== dest) {
      copyFileSync(localPath, dest);
    }
    log('info', 'storage.local.upload', { key, dest });
    return { id: dest, pathOrUri: dest };
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.fullPath(key));
  }

  async downloadTo(key: string, dest: string): Promise<void> {
    const src = this.fullPath(key);
    if (!existsSync(src)) {
      throw new Error(`storage.local.downloadTo: key not found: ${key}`);
    }
    ensureDir(dirname(dest));
    if (resolvePath(src) === resolvePath(dest)) return;
    copyFileSync(src, dest);
    log('info', 'storage.local.download', { key, dest });
  }
}

class GDriveStubBackend implements StorageBackend {
  async upload(): Promise<{ id: string; pathOrUri: string }> {
    throw new Error('TODO: GDrive backend not implemented yet');
  }
  async exists(): Promise<boolean> {
    throw new Error('TODO: GDrive backend not implemented yet');
  }
  async downloadTo(): Promise<void> {
    throw new Error('TODO: GDrive backend not implemented yet');
  }
}

let cached: StorageBackend | undefined;

export function getStorage(): StorageBackend {
  if (cached) return cached;
  if (env.GDRIVE_SA_JSON) {
    log('info', 'storage.backend', { backend: 'gdrive-stub' });
    cached = new GDriveStubBackend();
  } else {
    const root = env.CONTENT_BANK_VIDEOS_DIR ?? './data/videos';
    log('info', 'storage.backend', { backend: 'local-fs', root });
    cached = new LocalFsBackend(root);
  }
  return cached;
}
