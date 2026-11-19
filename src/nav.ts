import type { Locator, Page } from "playwright";
import { log, sleep } from "./log.js";

// Ikon SCORM dan video. Berkolaborasi dikenali terpisah.
// Terverifikasi: Pikirkan = `no-js-ScormIcon`, Perhatikan = `no-js-ActivityPlayIcon`.
const AUTO_ICON = /ScormIcon|ActivityPlayIcon/i;
// Perhatikan = video biasa di halaman (bukan SCORM): tercentang setelah dibuka lalu pindah item / refresh
const VIDEO_ICON = /ActivityPlayIcon/i;
// REDO=Praktikkan,Pikirkan 2 → item bernama itu tetap dibuka walau sudah tercentang (ulang buat perbaiki skor)
const REDO = new Set(
  (process.env.REDO ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** `redo` = item sudah tercentang tapi dibuka ulang (REDO) → centang nggak boleh dipakai sebagai tanda selesai. */
export type NavItem = { name: string; kind: "video" | "scorm" | "collaboration" | "feedback"; redo: boolean };

async function itemName(it: Locator) {
  const p = it.locator(".activity-name-section p").first();
  const raw = (await p.count()) ? await p.innerText() : await it.locator(".activity-name-section").innerText();
  return raw.trim();
}

const hasCheck = async (it: Locator) => (await it.locator(".activityCheckIcon").count()) > 0;

/** Item yang lagi aktif di sidebar sudah tercentang? */
export async function activeItemDone(page: Page) {
  return (await page.locator(".toc__is_active .activityCheckIcon, .toc__is_active.activityCheckIcon").count()) > 0;
}

/**
 * Buka semua accordion BAGIAN pelajaran (bukan modul). Item di bagian yang tertutup nggak ada di DOM
 * (14.17: "[nav] 3 bagian pelajaran, 2 item di DOM") → centangnya nggak bisa dicek.
 */
export async function expandLessonSections(page: Page) {
  const triggers = page.locator("button.accordion-trigger").filter({ hasNotText: /Pelajaran.*Diselesaika/i });
  const n = await triggers.count();
  for (let s = 0; s < n; s++) {
    const t = triggers.nth(s);
    if (!(await t.isVisible().catch(() => false))) continue;
    if ((await t.getAttribute("aria-expanded")) === "true") continue;
    await t.click({ timeout: 3000 }).catch(() => {});
    await sleep(600);
  }
}

/** Cek centang item berdasarkan nama (null = item nggak kelihatan/ketemu). */
export async function itemDone(page: Page, name: string): Promise<boolean | null> {
  const items = page.locator(".toc__children_container");
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    if ((await itemName(it).catch(() => "")) === name) return hasCheck(it);
  }
  return null;
}

/** Klik item sidebar yang namanya cocok (tanpa peduli centang). Return nama item, atau null kalau nggak ketemu. */
export async function clickItemByName(page: Page, re: RegExp): Promise<string | null> {
  await expandLessonSections(page);
  const items = page.locator(".toc__children_container");
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const name = await itemName(it).catch(() => "");
    if (!re.test(name) || !(await it.isVisible().catch(() => false))) continue;
    await it.locator(".toc-act-container").click({ timeout: 5000 });
    await sleep(3000);
    return name;
  }
  return null;
}

const seenIcons = new Set<string>();

/**
 * Buka item SCORM pertama yang belum tercentang. Return namanya, atau null kalau habis.
 * `autoSeen` diisi nama semua item ber-ikon otomatis yang kelihatan (tercentang atau belum) → buat bedain
 * "pelajaran sudah beres" vs "pelajaran tanpa item otomatis" (kuis, dll.).
 */
export async function openNextScormItem(
  page: Page,
  skip: Set<string>,
  autoSeen: Set<string> = new Set(),
): Promise<NavItem | null> {
  // Scan dulu yang sudah kelihatan, baru buka accordion kalau perlu
  const first = await scanVisible(page, skip, autoSeen);
  if (first) return first;

  const allItems = await page.locator(".toc__children_container").count();
  if (!allItems && !page.url().includes("/course-lesson/")) {
    log("[nav] Sidebar pelajaran (Pra-Kelas dll.) nggak ketemu → buka halaman pelajaran dulu");
    return null;
  }
  // Accordion MODUL ("x/y Pelajaran Telah Diselesaikan") jangan disentuh, cuma bagian pelajaran ("x/y Selesai")
  const triggers = page.locator("button.accordion-trigger").filter({ hasNotText: /Pelajaran.*Diselesaika/i });
  const sections = await triggers.count();
  log(`[nav] ${sections} bagian pelajaran, ${allItems} item di DOM`);

  // Per bagian: buka, lalu scan item yang kelihatan (aman kalau accordion saling menutup).
  // Accordion yang nggak kelihatan (di dalam panel induk tertutup) dilewati, klik dibatasi 3 detik.
  for (let s = 0; s < sections; s++) {
    const t = triggers.nth(s);
    if (!(await t.isVisible().catch(() => false))) continue;
    if ((await t.getAttribute("aria-expanded")) !== "true") {
      const label = (await t.innerText().catch(() => "")).trim().split("\n")[0].slice(0, 60);
      try {
        await t.click({ timeout: 3000 });
        await sleep(800);
      } catch {
        log(`[nav] Gagal buka accordion #${s} "${label}" → lewati`);
        continue;
      }
    }
    const name = await scanVisible(page, skip, autoSeen);
    if (name) return name;
  }
  return null;
}

async function scanVisible(page: Page, skip: Set<string>, autoSeen: Set<string>): Promise<NavItem | null> {
  const items = page.locator(".toc__children_container");
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    if (!(await it.isVisible())) continue;

    const name = await itemName(it);
    const done = await hasCheck(it);
    const icon = ((await it.locator(".activity-name-icon img").first().getAttribute("class").catch(() => null)) ?? "")
      .replace("wf_image", "")
      .trim();

    // Diagnostik sekali per item: buat verifikasi class ikon Perhatikan dkk.
    // Kunci per pelajaran (id wadah di URL), bukan per item: "Pikirkan 1" ada di tiap pelajaran
    const lesson = new URL(page.url()).pathname.split("/course-lesson/")[1]?.split("/")[0] ?? "";
    const iconKey = lesson + "|" + name;
    if (!seenIcons.has(iconKey)) {
      seenIcons.add(iconKey);
      log(`[ikon] ${name} → "${icon}"${done ? " ✔" : ""}`);
    }

    const collaboration = /^berkolaborasi$/i.test(name) || /no-js-Collaborate/i.test(icon);
    const feedback = /^umpan balik\b/i.test(name);
    const supported = feedback || collaboration || AUTO_ICON.test(icon);
    if (supported) autoSeen.add(name);
    if (skip.has(name)) continue;
    if (done && !REDO.has(name.toLowerCase())) continue;
    if (done) log(`Ulang (REDO): ${name} sudah tercentang tapi dibuka lagi`);
    if (!supported) {
      log(`Lewati (manual): ${name}`);
      skip.add(name);
      continue;
    }

    log(`Buka item: ${name}`);
    await it.locator(".toc-act-container").click();
    await sleep(3000);
    return { name, kind: feedback ? "feedback" : collaboration ? "collaboration" : VIDEO_ICON.test(icon) ? "video" : "scorm", redo: done };
  }
  return null;
}
