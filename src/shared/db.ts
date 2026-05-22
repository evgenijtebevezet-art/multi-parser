import { createClient, type Client } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env.js';

let client: Client | null = null;

export function getDb(): Client {
  if (client) return client;
  const url = env.TURSO_URL ?? 'file:./data/content-bank.db';
  const authToken = env.TURSO_TOKEN;
  client = createClient(authToken ? { url, authToken } : { url });
  return client;
}

export function now(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return randomUUID();
}

export async function runSchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  const db = getDb();
  const stripped = sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(stmt);
  }
}
