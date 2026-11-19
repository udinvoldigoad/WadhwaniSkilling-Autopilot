import type { Page } from 'playwright';
import { sleep } from './log.js';

export async function refreshAndOpenPost(page: Page, name: string) {
  await page.reload();
  const sectionDone = /^\s*di[\s-]+kelas\s*([1-9]\d*)\s*\/\s*\1\s*selesai/i;
  const checked = page.locator('.toc__children_container').filter({ hasText: name }).locator('.activityCheckIcon:visible');
  const complete = page.locator('button.accordion-trigger:visible').filter({ hasText: sectionDone });
  if (!await checked.or(complete).first().waitFor({ timeout: 20_000 }).then(() => true, () => false)) return false;
  const post = page.locator('button.accordion-trigger:visible').filter({ hasText: /^\s*pasca[\s-]+kelas/i }).first();
  if (await post.isVisible() && await post.getAttribute('aria-expanded') !== 'true') {
    await post.click({ timeout: 5000 }); await sleep(800);
  }
  return true;
}
