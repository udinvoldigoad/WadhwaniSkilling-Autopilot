import type { Frame, Page } from 'playwright';
import { pickAnswers, AiDownError } from './ai.js';
import { log, sleep } from './log.js';

const action = (f: Frame, name: RegExp) => f.getByRole('button', { name }).or(f.getByRole('link', { name })).first();

/** null = pelajaran biasa. Modul penilaian tidak memerlukan sidebar. */
export async function runAssessment(page: Page, pick = pickAnswers): Promise<boolean | null> {
  if (!await page.getByText(/^Modul Penilaian\b/i).and(page.locator(':visible')).first().isVisible()) return null;
  let started = false, finishedPage = false, submitted = false, confirmed = false;
  let previous = '', deadline = Date.now() + 25_000;
  let firstPageReady = false, requestedFirst = false;
  // Moodle menyimpan pilihan kosong di radio tersembunyi bernilai -1.
  const choices = 'input[type=radio]:visible:not([value="-1"])';
  const advanced = () => { deadline = Date.now() + 25_000; };
  try {
    for (let step = 0; step < 1000 && Date.now() < deadline; step++) {
      try { for (const f of page.frames()) {
        const resume = action(f, /^lanjutkan pengerjaan kuis yang terakhir$/i);
        const start = action(f, /^kerjakan kuis$/i);
        if (!started && await resume.isVisible()) {
          await resume.click(); started = true; advanced(); break;
        }
        if (await f.locator('table').getByText(/^(selesai|finished)(?:\s*$|\s*[:–-])/i).first().isVisible() ||
            await action(f, /^(selesaikan|akhiri|selesai) (reviu|ulasan)|^finish review$/i).isVisible()) return true;
        if (!started && await start.isVisible()) {
          await start.click(); started = true; advanced(); break;
        }
        const qs = f.locator('.que:visible').filter({ has: f.locator('.qtext') });
        const n = await qs.count();
        if (n && !finishedPage) {
          if (!firstPageReady) {
            const first = qs.first();
            const atOne = await first.getByText(/^(?:soal|question)\s*1$/i).first().isVisible() ||
              (await first.locator('.qno').first().textContent({ timeout: 300 }).catch(() => ''))?.trim() === '1';
            if (!atOne) {
              if (!requestedFirst) {
                const one = f.locator('a:visible,button:visible').filter({has: f.getByText(/^1$/)}).or(action(f, /^1$/)).or(f.locator('#quiznavbutton1:visible')).first();
                await one.click({timeout: 5000}); requestedFirst = true; advanced();
                log('[kuis] Kembali ke soal 1');
              }
              continue;
            }
            firstPageReady = true;
          }
          const key = JSON.stringify(await qs.locator('.qtext').allInnerTexts());
          if (previous === key) continue;
          for (let i = 0; i < n; i++) {
            const q = qs.nth(i), radios = q.locator(choices);
            if (await q.locator(`${choices}:checked`).count() === 1) continue;
            const prompt = (await q.locator('.qtext').innerText()).trim();
            const options = await radios.evaluateAll(els => els.map(el => {
              const r = el as HTMLInputElement;
              const ids = (r.getAttribute('aria-labelledby') || '').split(/\s+/);
              return (Array.from(r.labels ?? []).map(l => l.innerText).join(' ') || ids.map(id => document.getElementById(id)?.textContent || '').join(' ').trim() || r.parentElement?.innerText || '').trim();
            }));
            if (!prompt || options.length < 2 || options.some(v => !v) || new Set(options).size !== options.length) throw new Error('Teks soal atau pilihan radio tidak terbaca');
            const [answer] = await pick(options, 1, [], [prompt]);
            if (!Number.isInteger(answer) || !options[answer - 1]) throw new Error('Nomor jawaban AI tidak valid');
            if ((await q.locator('.qtext').innerText()).trim() !== prompt) throw new Error('Soal berubah saat menunggu AI');
            await radios.nth(answer - 1).check();
              log(`[kuis] ${prompt.slice(0, 65)} → pilihan ${answer}`);
          }
          for (const q of await qs.all()) {
            if (await q.locator(`${choices}:checked`).count() !== 1) throw new Error('Radio jawaban belum terpilih → tidak pindah soal');
          }
          if (JSON.stringify(await qs.locator('.qtext').allInnerTexts()) !== key) continue;
          const next = action(f, /^halaman selanjutnya$/i);
          if (await next.isVisible()) await next.click();
          else {
            // Pakai tombol akhir formulir, bukan tautan selesai di navigasi samping.
            await f.getByRole('button', { name: /^selesaikan kuis[.…]*$/i }).click({ timeout: 5000 });
            finishedPage = true;
          }
          started = true; previous = key; advanced(); break;
        }
        const submitName = /^(?:serahkan|kirim)(?: semua)?(?: jawaban)? dan (?:selesai|akhiri)|^submit all and finish$/i;
        const submit = action(f, submitName);
        if (!submitted && await submit.isVisible()) {
          const missing = f.getByRole('row').filter({hasText: /belum dijawab|belum terjawab|not yet answered/i}).first();
          if (await missing.isVisible()) {
            await missing.getByRole('link').first().click({timeout: 5000}); previous = ''; finishedPage = false;
          } else { await submit.click(); submitted = true; }
          advanced(); break;
        }
        const confirm = f.getByRole('dialog').getByRole('button', {name: submitName});
        if (submitted && !confirmed && await confirm.isVisible()) { await confirm.click(); confirmed = true; advanced(); break; }
      } } catch (e) {
        if (!/execution context was destroyed|frame (?:was|has been) detached|cannot find context with specified id/i.test(String(e))) throw e;
        // Halaman iframe diganti saat resume/Next. Ulangi pembacaan pada frame baru.
      }
      await sleep(300);
    }
    throw new Error('Transisi atau status selesai kuis belum terkonfirmasi');
  } catch (e) {
    if (e instanceof AiDownError) throw e;
    log(`[kuis] ${e instanceof Error ? e.message : e} → berhenti di modul ini`);
    return false;
  }
}
