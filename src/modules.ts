import type { Page } from 'playwright';
import { lessonURL } from './session.js';
import { log } from './log.js';

// Periksa daftar kursus di tab sementara sehingga posisi asal tetap tersedia jika ambigu.
export async function nextModule(page: Page): Promise<boolean> {
  const lesson = lessonURL(page.url());
  if (!lesson) return false;
  const course = lesson.split('/course-lesson/')[0];
  const catalog = await page.context().newPage();
  try {
    await catalog.goto(course);
    const modules = catalog.locator('button.accordion-trigger:visible');
    await modules.first().waitFor({timeout: 8000});
    const progress = /(\d+)\s*\/\s*(\d+)\s*Pelajaran\s+(?:yang\s+)?Telah Diselesaikan/i;
    const titles = await modules.allInnerTexts();
    let current = -1;
    for (const [i, text] of titles.entries()) {
      const title = text.replace(progress, '').trim();
      if (title && await page.getByText(title, {exact:true}).and(page.locator(':visible')).count()) {
        if (current !== -1) return false;
        current = i;
      }
    }
    if (current < 0) return false;
    for (let i = current; i < titles.length; i++) {
      const m = titles[i].match(progress);
      if (!m || +m[2] <= 0 || +m[1] > +m[2]) return false;
      if (+m[1] === +m[2]) continue;
      if (i === current) return false;
      const trigger = modules.nth(i), id = await trigger.getAttribute('aria-controls');
      if (!id) return false;
      if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
      const panel = catalog.locator(`[id=${JSON.stringify(id)}]`);
      const links = panel.locator('a[href*="/course-lesson/"]:visible');
      await links.first().waitFor({timeout:5000});
      for (const link of await links.all()) {
        const row = link.locator('xpath=ancestor-or-self::*[self::li or contains(@class,"toc__children_container")][1]');
        if (await row.locator('.activityCheckIcon').count() || await link.locator('.activityCheckIcon').count()) continue;
        const target = lessonURL(await link.evaluate(a => (a as HTMLAnchorElement).href));
        if (!target?.startsWith(course + '/course-lesson/') || target === lesson) return false;
        await page.goto(target);
        if (lessonURL(page.url()) !== target) return false;
        log(`[modul] Buka ${titles[i].replace(progress,'').trim()}`);
        return true;
      }
      return false;
    }
    return false;
  } catch { return false; } finally { await catalog.close(); }
}
