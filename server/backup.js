// Database backups: a full copy of app.db in DATA_DIR/backups (on the host
// that's ~/docker-sites/pre-con-commander/data/backups). One is made
// automatically every 24 hours and the newest 14 automatic ones are kept;
// the admin can make one at any time and download any of them.
// VACUUM INTO writes a consistent, compacted copy while the site keeps running.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_AUTO = 14;
const DAY = 24 * 3600e3;
const NAME = /^app-(auto|manual)-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => NAME.test(f)).map(f => {
    const st = fs.statSync(path.join(BACKUP_DIR, f));
    return { name: f, auto: f.includes('-auto-'), size: st.size, at: st.mtime.toISOString() };
  }).sort((a, b) => b.at.localeCompare(a.at));
}
export function makeBackup(kind = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `app-${kind}-${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}-${stamp.slice(9, 15)}.db`;
  const file = path.join(BACKUP_DIR, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // Keep the newest automatic backups; manual ones stay until deleted by hand.
  for (const old of listBackups().filter(b => b.auto).slice(KEEP_AUTO)) fs.rmSync(path.join(BACKUP_DIR, old.name));
  return listBackups().find(b => b.name === name);
}
// Only names this module made can be read back (no paths).
export function backupFile(name) {
  if (!NAME.test(String(name))) return null;
  const file = path.join(BACKUP_DIR, name);
  return fs.existsSync(file) ? file : null;
}
export function scheduleBackups() {
  const check = () => {
    const last = listBackups().find(b => b.auto);
    if (!last || Date.now() - Date.parse(last.at) > DAY) {
      try { makeBackup('auto'); } catch (err) { console.error('Automatic backup failed:', err.message); }
    }
  };
  setTimeout(check, 30e3).unref();
  setInterval(check, 3600e3).unref();
}
