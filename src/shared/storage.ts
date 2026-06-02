import { createReadStream, existsSync, mkdirSync, copyFileSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve as resolvePath, basename } from 'node:path';
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

type GDriveAuth =
  | { kind: 'oauth'; clientId: string; clientSecret: string; refreshToken: string; quotaProject?: string }
  | { kind: 'sa'; saJson: string };

class GDriveBackend implements StorageBackend {
  private driveP: Promise<import('googleapis').drive_v3.Drive> | null = null;
  private readonly folderId: string;
  private readonly folderCache = new Map<string, string>();

  constructor(auth: GDriveAuth, folderId: string) {
    this.folderId = folderId;
    this.driveP = this.init(auth);
  }

  private async init(auth: GDriveAuth): Promise<import('googleapis').drive_v3.Drive> {
    const { google } = await import('googleapis');
    if (auth.kind === 'oauth') {
      // Personal (@gmail) Drive: service accounts have zero storage quota, so we
      // upload as the user via an OAuth refresh token (files owned by the user,
      // counted against their quota). The OAuth client is Google's own gcloud
      // client, which has no Drive API enabled — so Drive quota/enablement must
      // be attributed to OUR project via the x-goog-user-project header, which
      // google-auth-library injects when quotaProjectId is set.
      const oauth = new google.auth.OAuth2({
        clientId: auth.clientId,
        clientSecret: auth.clientSecret
      });
      oauth.setCredentials({ refresh_token: auth.refreshToken });
      if (auth.quotaProject) oauth.quotaProjectId = auth.quotaProject;
      return google.drive({ version: 'v3', auth: oauth });
    }
    const credentials = JSON.parse(auth.saJson) as { client_email: string; private_key: string };
    const jwt = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    await jwt.authorize();
    return google.drive({ version: 'v3', auth: jwt });
  }

  private async drive(): Promise<import('googleapis').drive_v3.Drive> {
    if (!this.driveP) throw new Error('gdrive: not initialized');
    return this.driveP;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const cacheKey = `${parentId}/${name}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return cached;

    const drive = await this.drive();
    const safeName = name.replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const list = await drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    const found = list.data.files?.[0]?.id;
    if (found) {
      this.folderCache.set(cacheKey, found);
      return found;
    }
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      },
      fields: 'id',
      supportsAllDrives: true
    });
    const newId = created.data.id;
    if (!newId) throw new Error(`gdrive: failed to create folder ${name}`);
    this.folderCache.set(cacheKey, newId);
    return newId;
  }

  private async resolveParentFolder(key: string): Promise<{ parentId: string; fileName: string }> {
    const parts = key.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) throw new Error(`gdrive: empty key`);
    const fileName = parts.pop()!;
    let parent = this.folderId;
    for (const segment of parts) {
      parent = await this.ensureFolder(parent, segment);
    }
    return { parentId: parent, fileName };
  }

  private async findFile(parentId: string, name: string): Promise<string | null> {
    const drive = await this.drive();
    const safeName = name.replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and trashed = false`;
    const list = await drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    return list.data.files?.[0]?.id ?? null;
  }

  async upload(localPath: string, key: string): Promise<{ id: string; pathOrUri: string }> {
    const drive = await this.drive();
    const { parentId, fileName } = await this.resolveParentFolder(key);
    const existing = await this.findFile(parentId, fileName);
    const body = createReadStream(localPath);
    let id: string;
    if (existing) {
      const upd = await drive.files.update({
        fileId: existing,
        media: { body },
        fields: 'id',
        supportsAllDrives: true
      });
      id = upd.data.id ?? existing;
    } else {
      const created = await drive.files.create({
        requestBody: { name: fileName, parents: [parentId] },
        media: { body },
        fields: 'id',
        supportsAllDrives: true
      });
      id = created.data.id ?? '';
    }
    if (!id) throw new Error(`gdrive: upload returned no id for ${key}`);
    const uri = `gdrive://${id}`;
    log('info', 'storage.gdrive.upload', { key, id });
    return { id, pathOrUri: uri };
  }

  async exists(key: string): Promise<boolean> {
    try {
      const { parentId, fileName } = await this.resolveParentFolder(key);
      const id = await this.findFile(parentId, fileName);
      return id !== null;
    } catch {
      return false;
    }
  }

  async downloadTo(key: string, dest: string): Promise<void> {
    const drive = await this.drive();
    const { parentId, fileName } = await this.resolveParentFolder(key);
    const id = await this.findFile(parentId, fileName);
    if (!id) throw new Error(`gdrive.downloadTo: not found ${key}`);
    ensureDir(dirname(dest));
    const res = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(dest);
      res.data.on('error', reject);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.data.pipe(out);
    });
    log('info', 'storage.gdrive.download', { key, dest });
  }
}

let cached: StorageBackend | undefined;

export function getStorage(): StorageBackend {
  if (cached) return cached;
  const folderId = process.env.GDRIVE_FOLDER_ID;
  if (env.GDRIVE_OAUTH_CLIENT_ID && env.GDRIVE_OAUTH_REFRESH_TOKEN && folderId) {
    log('info', 'storage.backend', { backend: 'gdrive-oauth', folderId });
    cached = new GDriveBackend(
      {
        kind: 'oauth',
        clientId: env.GDRIVE_OAUTH_CLIENT_ID,
        clientSecret: env.GDRIVE_OAUTH_CLIENT_SECRET ?? '',
        refreshToken: env.GDRIVE_OAUTH_REFRESH_TOKEN,
        quotaProject: env.GDRIVE_QUOTA_PROJECT
      },
      folderId
    );
  } else if (env.GDRIVE_SA_JSON && folderId) {
    log('info', 'storage.backend', { backend: 'gdrive-sa', folderId });
    cached = new GDriveBackend({ kind: 'sa', saJson: env.GDRIVE_SA_JSON }, folderId);
  } else {
    const root = env.CONTENT_BANK_VIDEOS_DIR ?? './data/videos';
    log('info', 'storage.backend', { backend: 'local-fs', root });
    cached = new LocalFsBackend(root);
  }
  return cached;
}
