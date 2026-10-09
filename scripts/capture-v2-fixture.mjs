// Capture only the synthetic V2 native test database; never point this at production data.
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const report = JSON.parse(await readFile(join(root, 'docs/v2-native-results.json'), 'utf8'));
const db = new DatabaseSync(join(report.directory, 'startflow.sqlite3'), { readOnly: true });
if (db.prepare('SELECT MAX(version) AS n FROM migrations').get().n !== 2)
  throw Error('Expected original V2 fixture');
const quote = (v) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
let sql =
  '-- Captured from the real, synthetic V2 native fixture referenced by docs/v2-native-results.json.\nPRAGMA foreign_keys=OFF;\n';
const objects = db
  .prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  )
  .all();
for (const o of objects) sql += o.sql + ';\n';
for (const o of objects.filter((o) => o.type === 'table'))
  for (const row of db.prepare(`SELECT * FROM "${o.name}"`).all())
    sql += `INSERT INTO "${o.name}" VALUES(${Object.values(row).map(quote).join(',')});\n`;
sql += 'PRAGMA foreign_keys=ON;\n';
db.close();
await writeFile(join(root, 'src-tauri/tests/fixtures/v2-populated.sql'), sql);
