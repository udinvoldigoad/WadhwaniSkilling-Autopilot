import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { log, LOG_FILE } from './log.js';

const path = 'logs/checkpoint.json';
export function lessonURL(raw: string) {
  try {
    const u = new URL(raw);
    if (u.origin === 'https://skilling.wadhwanifoundation.org' && /^\/id\/courses\/[\w-]+\/course-lesson\/\d+\/\d+\/?$/.test(u.pathname)) return u.origin + u.pathname;
  } catch {}
}
export function resumeURL() {
  try { return lessonURL(JSON.parse(readFileSync(path, 'utf8')).url); } catch { return undefined; }
}
export function checkpoint(raw: string, step: string) {
  const url = lessonURL(raw);
  if (!url) return;
  try {
    writeFileSync(path + '.tmp', JSON.stringify({ url, step, time: new Date() }));
    renameSync(path + '.tmp', path);
  } catch { log('[checkpoint] Gagal menyimpan posisi'); }
}
type Status = 'terkonfirmasi' | 'menunggu centang' | 'perlu bantuan';
const rows = new Map<string, Status>();
export function note(url: string, item: string, status: Status) {
  rows.set(`${url.split('/course-lesson/').pop()?.split('/')[0]} / ${item}`, status);
  if (status === 'terkonfirmasi') checkpoint(url, item + ' terkonfirmasi');
}
export function recap() {
  for (const status of ['terkonfirmasi','menunggu centang','perlu bantuan'] as const) {
    const items = [...rows].filter(([,s]) => s === status).map(([k]) => k);
    log(`[rekap] ${status} (${items.length}): ${items.join(' | ') || '—'}`);
  }
}
export async function diagnose(page: Page, item: string, reason: string) {
  note(page.url(), item, 'perlu bantuan');
  const file = `${LOG_FILE}.${Date.now()}.png`;
  let number = '';
  for (const f of page.frames()) {
    const q = f.locator('.que:visible .qno').first();
    if (await q.isVisible().catch(() => false)) number = await q.innerText({timeout: 500}).catch(() => '');
  }
  log(`[diag] ${lessonURL(page.url()) || 'halaman navigasi'} | ${item}${number ? ' | soal '+number : ''} | ${reason}`);
  await page.screenshot({path: file, timeout: 3000}).then(() => log(`[diag] Screenshot: ${file}`), () => log('[diag] Screenshot tidak tersedia'));
}
