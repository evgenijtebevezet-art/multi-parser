import { getDb } from '../shared/db.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const sql = await readFile(resolve(here, '../shared/schema.sql'), 'utf8');
const db = getDb();
const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('--'));
console.log('total stmts:', stmts.length);
for (let i = 0; i < stmts.length; i++) {
  const preview = stmts[i].substring(0, 100).replace(/\n/g, ' ');
  try {
    await db.execute(stmts[i]);
    console.log('OK ', i, preview);
  } catch (e) {
    console.log('ERR', i, preview);
    console.log('  reason:', (e as Error).message);
  }
}
