import type { Page } from 'playwright';
import { AiDownError, pickAnswers } from './ai.js';
import { log, sleep } from './log.js';
import { itemDone } from './nav.js';

export async function runFeedback(page: Page, name: string): Promise<boolean> {
  let opened = false;
  try {
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      for (const frame of page.frames()) {
        const action = (re: RegExp) => frame.getByRole('button', { name: re }).or(frame.getByRole('link', { name: re }));
        const submit = action(/^serahkan jawaban anda$/i);
        if (await submit.isVisible()) {
          const form = submit.locator('xpath=ancestor::form[1]');
          const radios = form.locator('input[type=radio]:visible');
          const options = await radios.evaluateAll(nodes => nodes.map(node => {
            const r = node as HTMLInputElement;
            return { group: r.name, label: (r.labels?.[0]?.innerText || r.getAttribute('aria-label') || r.nextSibling?.textContent || '').trim() };
          }));
          if (options.length < 2 || options.some(o => !o.label || o.group !== options[0].group)) throw new Error('Pilihan survei tidak terbaca sebagai satu grup');
          const [choice] = await pickAnswers(options.map(o => o.label), 1, [], [await form.innerText()]);
          if (!Number.isInteger(choice) || !options[choice - 1]) throw new Error('Nomor pilihan AI tidak valid');
          await radios.nth(choice - 1).check();
          await submit.click();
          log(`[umpan balik] Jawaban diserahkan: ${options[choice - 1].label}`);
          for (let i = 0; i < 40; i++) {
            if (await itemDone(page, name)) return true;
            if (!frame.isDetached() && !(await submit.isVisible()) && await frame.getByText(/^(terima kasih|thank you|jawaban anda (?:telah |berhasil )?(?:disimpan|dikirim))/i).first().isVisible()) return true;
            await sleep(250);
          }
          await page.reload();
          await page.locator('.toc__children_container').filter({ hasText: name }).locator('.activityCheckIcon').first().waitFor({timeout: 15_000});
          return true;
        }
        const start = action(/^jawablah pertanyaan$/i);
        if (!opened && await start.isVisible()) { await start.click(); opened = true; break; }
      }
      await sleep(300);
    }
    throw new Error('Formulir tidak ditemukan');
  } catch (error) {
    if (error instanceof AiDownError) throw error;
    log(`[umpan balik] ${error instanceof Error ? error.message : error} → berhenti untuk diperiksa`);
    return false;
  }
}
