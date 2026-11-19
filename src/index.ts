import readline from "node:readline/promises";
import type { Page } from "playwright";
import { openBrowser } from "./browser.js";
import { runScorm } from "./scorm.js";
import { runFeedback } from "./feedback.js";
import { runAssessment } from "./quiz.js";
import { runCollaboration } from "./collaboration.js";
import { activeItemDone, clickItemByName, expandLessonSections, itemDone, openNextScormItem } from "./nav.js";
import { LOG_FILE, log, sleep } from "./log.js";
import { AiDownError, checkAi } from "./ai.js";
import { checkpoint, diagnose, note, recap, resumeURL } from './session.js';
import { nextModule } from './modules.js';
import { refreshAndOpenPost } from './post.js';

// Batas pelajaran yang DIKERJAKAN per run (pelajaran yang sudah beres nggak dihitung)
const MAX_LESSONS = Number(process.env.MAX_PELAJARAN ?? 5);
// Batas keras jumlah halaman pelajaran yang dikunjungi (termasuk yang sudah beres) → pengaman loop
const MAX_VISITS = MAX_LESSONS * 4 + 10;
// Berhenti kalau segini pelajaran berturut-turut sama sekali nggak punya item otomatis (kuis, dll.)
const MAX_EMPTY_STREAK = 2;

// Cek 9Router dulu: kalau mati, berhenti sebelum buka browser (crash 11.47: "Connection error" di tengah soal)
const aiProblem = await checkAi();
if (aiProblem) {
  log(`✖ AI ${aiProblem} → nyalakan 9Router dulu, lalu jalankan ulang`);
  process.exit(1);
}

const { page } = await openBrowser();
// Browser ditutup manual → berhenti rapi, bukan crash "Target page… has been closed"
page.on("close", () => {
  recap();
  log("Browser ditutup → berhenti");
  process.exit(0);
});
await page.goto("https://skilling.wadhwanifoundation.org/id/home");

const START_URL = process.env.START_URL || (process.env.RESUME !== '0' && resumeURL());
if (START_URL) {
  // Mode tanpa interaksi: langsung buka halaman pelajaran (sama kayak ngetik URL di address bar)
  await page.goto(START_URL);
  await page.locator(".toc__children_container").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  if (!page.url().includes("/course-lesson/")) {
    log('Pelajaran tidak terbuka. Untuk login manual, kosongkan START_URL dan gunakan RESUME=0.');
    process.exit(1);
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Login (kalau perlu), buka PELAJARAN yang mau dikerjain (halaman yang ada sidebar Pra-Kelas), lalu Enter...");
  // Halaman course (daftar modul) bukan halaman pelajaran → minta ulang
  while (!page.url().includes("/course-lesson/")) {
    await rl.question(`Ini bukan halaman pelajaran (${new URL(page.url()).pathname}). Klik satu pelajaran sampai sidebar Pra-Kelas muncul, lalu Enter...`);
  }
  rl.close();
}

const lessonId = (p: Page) => new URL(p.url()).pathname.split("/course-lesson/")[1] ?? p.url();
let currentItem = 'Pelajaran';

/**
 * Kerjain semua item otomatis di halaman pelajaran sekarang.
 * `opened` = item yang dibuka bot, `auto` = item ber-ikon otomatis yang kelihatan (tercentang atau belum).
 */
async function runLesson(manual: Set<string>): Promise<{ opened: number; auto: number; blocked?: boolean; feedbackDone?: boolean }> {
  const quiz = await runAssessment(page);
  if (quiz !== null) { currentItem = 'Modul Penilaian'; note(page.url(), currentItem, quiz ? 'terkonfirmasi' : 'perlu bantuan'); return { opened: 1, auto: 1, blocked: !quiz, feedbackDone: quiz }; }
  const skip = new Set<string>();
  // Item yang sampai akhir tapi belum tercentang: dicek lagi setelah pindah item / refresh
  const pending = new Map<string, number>();
  let opened = 0;
  const autoSeen = new Set<string>();

  const checkPending = async (when: string) => {
    for (const [name, t0] of pending) {
      if (await itemDone(page, name).catch(() => null)) {
        log(`[centang] ${name} tercentang ${when}, ${Math.round((Date.now() - t0) / 1000)} detik kemudian`);
        pending.delete(name);
        note(page.url(), name, 'terkonfirmasi');
      }
    }
  };

  while (true) {
    const before = new Set(skip);
    const item = await openNextScormItem(page, skip, autoSeen);
    // Item yang ditambahkan nav ke skip tanpa dibuka = manual
    for (const s of skip) if (!before.has(s) && s !== item?.name) { manual.add(s); note(page.url(), s, 'perlu bantuan'); }
    await checkPending("setelah pindah item");

    if (!item) {
      if (pending.size) {
        // Centang baru muncul setelah refresh / pindah item (terverifikasi)
        log("Refresh halaman buat konfirmasi centang");
        await page.reload();
        await page.locator(".toc__children_container").first().waitFor({ timeout: 20_000 }).catch(() => {});
        await sleep(2000);
        await expandLessonSections(page); // item di bagian tertutup nggak ada di DOM
        await checkPending("setelah refresh");
      }
      if (pending.size) log(`⚠ Masih belum tercentang: ${[...pending.keys()].join(", ")} → cek manual`);
      const post = page.locator('button.accordion-trigger:visible').filter({ hasText: /^\s*pasca[\s-]+kelas/i }).first();
      if (await post.isVisible() && !/\b([1-9]\d*)\s*\/\s*\1\s*selesai/i.test(await post.innerText())) {
        log('Pasca kelas belum terkonfirmasi selesai → tetap di pelajaran ini');
        return { opened, auto: autoSeen.size, blocked: true };
      }
      return { opened, auto: autoSeen.size };
    }

    const { name, kind, redo } = item;
    currentItem = name;
    checkpoint(page.url(), `Item terbuka: ${name}`);
    skip.add(name); // jangan dibuka ulang di pelajaran ini, apa pun hasilnya
    opened++;

    if (kind === "feedback") {
      if (!(await runFeedback(page, name))) return { opened, auto: autoSeen.size, blocked: true };
      note(page.url(), name, 'terkonfirmasi');
      return { opened, auto: autoSeen.size, feedbackDone: true };
    }

    if (kind === "collaboration") {
      if (!(await runCollaboration(page, name))) {
        log(`[kolaborasi] ${name} belum terkonfirmasi selesai → berhenti di pelajaran ini`);
        return { opened, auto: autoSeen.size, blocked: true };
      }
      log(`${name} selesai → refresh sekali untuk konfirmasi centang`);
      if (!(await refreshAndOpenPost(page, name))) {
        log(`${name} belum tercentang setelah refresh → berhenti di pelajaran ini`);
        return { opened, auto: autoSeen.size, blocked: true };
      }
      note(page.url(), name, 'terkonfirmasi');
      continue;
    }

    if (kind === "video") {
      // Perhatikan: video biasa, tercentang setelah dibuka lalu pindah item / refresh (terverifikasi)
      await sleep(5000);
      log(`${name} sudah dibuka → lanjut, centang dicek setelah pindah item`);
      pending.set(name, Date.now());
      note(page.url(), name, 'menunggu centang');
      continue;
    }

    // Item REDO sudah tercentang dari awal → jangan pakai centang sebagai tanda selesai (11.59: langsung "done"
    // dalam 4 dtk tanpa ngerjain apa-apa). Biarin konten sampai Hasil / keluar sendiri.
    const res = await runScorm(page, redo ? async () => false : () => activeItemDone(page));
    if (res === "done") { note(page.url(), name, 'terkonfirmasi'); log(`✔ ${name} tercentang`); }
    else if (res === "end") {
      // Centang nggak muncul di tempat; baru setelah pindah item / refresh → langsung lanjut
      log(`${name} sampai akhir → lanjut, centang dicek setelah pindah item`);
      pending.set(name, Date.now());
      note(page.url(), name, 'menunggu centang');
    } else await diagnose(page, name, 'SCORM macet → dilewati, cek manual');
  }
}

/** Klik tombol "Pelajaran Selanjutnya" (button.arrow-btns, terverifikasi). Return false kalau gagal. */
async function goNextLesson(): Promise<boolean> {
  const btn = page.locator("button.arrow-btns", { hasText: "Pelajaran Selanjutnya" });
  const missing = async () => !(await btn.count()) || (await btn.first().isDisabled().catch(() => true));
  if (await missing()) {
    // 16.32: habis Berkolaborasi halaman masih di aktivitas kolaborasi (tanpa tombol) → buka Praktikkan dulu
    const opened = await clickItemByName(page, /^praktikkan$/i);
    if (opened) {
      log(`Tombol "Pelajaran Selanjutnya" belum ada → buka ${opened} dulu`);
      await btn.first().waitFor({ timeout: 10_000 }).catch(() => {});
    }
  }
  if (await missing()) {
    // Di sebagian pelajaran tombol berikutnya hanya tersedia pada item terakhir.
    if (await clickItemByName(page, /^pelajari lebih lanjut$/i)) {
      await btn.first().waitFor({ timeout: 5000 }).catch(() => {});
    }
  }
  if (await missing()) {
    if (process.env.NEXT_MODULE !== '0' && await nextModule(page)) {
      checkpoint(page.url(), 'Modul berikutnya terbuka');
      return true;
    }
    log('Tidak ada tujuan berikutnya yang terkonfirmasi');
    return false;
  }
  const from = page.url();
  await btn.first().click();
  try {
    await page.waitForURL((u) => u.toString() !== from, { timeout: 15_000 });
  } catch {
    log("URL nggak berubah setelah klik Pelajaran Selanjutnya");
    return false;
  }
  await page.locator(".toc__children_container").first().waitFor({ timeout: 20_000 }).catch(() => {});
  await sleep(2000);
  checkpoint(page.url(), 'Pelajaran berikutnya terbuka');
  return true;
}

log(`Mulai (maks ${MAX_LESSONS} pelajaran dikerjakan) — log disimpan di ${LOG_FILE}`);
const manual = new Set<string>();
let emptyStreak = 0;
let worked = 0;

for (let visit = 1; visit <= MAX_VISITS; visit++) {
  currentItem = 'Pelajaran';
  checkpoint(page.url(), 'Halaman pelajaran terbuka');
  log(`=== Pelajaran (dikerjakan ${worked}/${MAX_LESSONS}): ${lessonId(page)}`);
  let res: Awaited<ReturnType<typeof runLesson>>;
  try {
    res = await runLesson(manual);
  } catch (e) {
    await diagnose(page, currentItem, e instanceof Error ? e.message.split('\n')[0] : 'Kesalahan pelajaran');
    if (!(e instanceof AiDownError)) break;
    // AI mati di tengah jalan (sudah dicoba ulang ±2 mnt) → berhenti rapi; item yang lagi dibuka belum selesai
    log(`✖ ${e.message} → berhenti. Nyalakan 9Router lalu jalankan ulang dari ${page.url()}`);
    break;
  }
  const { opened, auto } = res;
  if (res.blocked) { await diagnose(page, currentItem, 'Menunggu konfirmasi progres; lihat log tepat sebelum ini'); break; }

  if (opened) {
    worked++;
    log(`Pelajaran beres (${opened} item dibuka)`);
  } else if (auto) {
    log(`Sudah beres sebelumnya (${auto} item otomatis tercentang) → lewati`);
  } else {
    log("Nggak ada item otomatis sama sekali di halaman ini");
  }

  emptyStreak = auto ? 0 : emptyStreak + 1;
  if (emptyStreak >= MAX_EMPTY_STREAK) {
    log(`${MAX_EMPTY_STREAK} halaman berturut-turut tanpa item otomatis → berhenti (cek manual: kuis?)`);
    break;
  }
  if (worked >= MAX_LESSONS) {
    if (res.feedbackDone || await page.locator('button.accordion-trigger:visible').filter({ hasText: /^\s*pasca[\s-]+kelas\s*([1-9]\d*)\s*\/\s*\1\s*selesai/i }).count()) await goNextLesson();
    log(`Batas ${MAX_LESSONS} pelajaran dikerjakan tercapai (ubah lewat MAX_PELAJARAN di .env)`);
    break;
  }
  if (visit === MAX_VISITS) {
    log(`Batas ${MAX_VISITS} halaman dikunjungi tercapai → berhenti`);
    break;
  }
  if (!(await goNextLesson())) break;
}

if (manual.size) log(`Perlu dikerjain manual: ${[...manual].join(" | ")}`);
recap();
log("Selesai. Browser dibiarkan terbuka.");
// Dari panel: sambungan CDP bikin proses tetap hidup → keluar; Chrome tetap terbuka (milik panel)
if (process.env.BOT_CDP) process.exit(0);
