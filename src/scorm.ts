import type { ElementHandle, Frame, Page } from "playwright";
import { describeImage, pickAnswers, pickDropdowns } from "./ai.js";
import { log, sleep } from "./log.js";

// Teks bawaan Storyline yang bukan soal/opsi
const NOISE = /^(Oval|Rectangle|Group|Untitled|©)|^(Pikirkan|Kirim|Sisa Percobaan|Close)$|^\d+$|^Think \d+$|\.(png|jpe?g|gif|svg|webp|mp4|mp3|wav|webm)$|^\d+…+\d+$/i;
// Teks feedback setelah Kirim. Benar: "Benar!" / "Kerja bagus!". Salah: "Belum tepat!" (terverifikasi 12.07)
// "Bagus! …" terverifikasi 14.44 (Pikirkan 2 course-lesson/144)
const CORRECT = /^(benar|kerja bagus|bagus|mantap|luar biasa|hebat)/i;
const WRONG = /^(belum tepat|salah|kurang tepat)/i;
const FEEDBACK = /^(benar|kerja bagus|bagus|mantap|luar biasa|hebat|belum tepat|salah|kurang tepat|coba lagi|selesai|lanjutkan|perlu ditingkatkan)|klik selanjutnya/i;
// Layar hasil skenario bercabang (Pasca kelas "Praktikkan"): "Perlu ditingkatkan! … Kalah-Kalah" + Coba Lagi/Selesai
// (terverifikasi 12.58). Teks hasil bagus belum kelihatan → apa pun hasilnya, klik "Selesai".
const OUTCOME = /^perlu ditingkatkan|kalah-kalah|menang-menang/i;
// Tombol penutup layer feedback
const CLOSE_BTN = /^(selesai|coba lagi|lanjutkan)$/i;
// Tombol mulai di slide judul (Pasca kelas "Praktikkan": "Mulai", terverifikasi 12.51)
const START_BTN = /^mulai$/i;
// Slide judul "EXPLORE" (Pasca kelas "Pelajari lebih lanjut"): gambar play2.png + "Klik tombol play untuk memulai."
// (terverifikasi 13.14). Nama file gambar biasanya disaring sebagai noise, jadi ditangani khusus.
const PLAY_HINT = /klik tombol play untuk memulai/i;
const PLAY_IMG = /^play\d*\.png$/i;
// Slide hasil kuis Storyline: "Results / Your Score: / 100% (30 points) / Passing Score: …" (terverifikasi 13.13)
// Versi ID: "Hasil / Nilai Anda: / 0% (0 points)" (terverifikasi 14.45, course-lesson/144)
const RESULTS = /^(your score|skor anda|nilai anda):?$/i;
// Halaman daftar tautan Eksplorasi ("Tautan Situs Web" / "Tautan Video") + tombol "Keluar" (terverifikasi 13.17).
// Tautan nggak perlu dibuka: klik Keluar → item tercentang (dikonfirmasi pengguna)
const EXPLORE_LINKS = /^tautan (situs web|video)$/i;
// Slide interaktif "Klik ikon <x> untuk …" (Praktikkan course-lesson/128: "Klik ikon surel untuk membaca surel.",
// timeline muter terus sampai ikonnya diklik). Nama elemen ikon BELUM di-recon → pola kandidat + log mentah.
const HINT_ICON = /^klik ikon (\S+)/i;
// "Klik pada setiap anggota tim untuk melihat setiap perspektif mereka." (Praktikkan 148, 11.51) → klik tiap nama
// (Monica / Kris / Rita). Dulu dilewati pakai Next → skor 20/30 walau semua soal benar.
// Tombol X popup bergambar: "close button illustration 1.png" (Praktikkan 148), "wrong.png" (popup surel 128)
const CLOSE_ICON = /^close button|^close.*\.png$|^wrong\.png$/i;
const HINT_EACH = /^klik (pada )?(setiap|tiap|masing-masing)\s/i;
// Soal urutan lewat menu tarik-turun (Praktikkan course-lesson/128, 13.51): baris "1. Monica, …" + "down arrow icon 1"
const DROPDOWN_HINT = /tarik-turun|drop-?down/i;
// Slide menu skenario (Praktikkan course-lesson/132, 14.16): "Situasi 1: …", "Situasi 2: …", "Situasi 3: …".
// Tiap situasi harus diklik & dikerjakan; dulu bot klik Next → langsung ke Results 0%.
const MENU_ITEM = /^(situasi|skenario|kasus)\s+\d+\b/i;
const ICON_TARGET: Record<string, RegExp> = {
  surel: /surel|e-?mail|mail|envelope|amplop|inbox/i, // terverifikasi 13.39: "click_Mail.png"
  informasi: /^i$|info/i,
};
const NUM_WORDS: Record<string, number> = {
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9,
};

type Item = { text: string; el: ElementHandle };

/** Konten SCORM sudah keluar sendiri ("Konten sudah habis. Anda boleh menutup jendela ini.") */
async function contentExited(page: Page) {
  for (const f of page.frames()) {
    // Versi ID & EN (goodbye.html: "The content has ended. You may close this window.", terverifikasi 13.06)
    if (await f.getByText(/Konten sudah habis|The content has ended/i).count().catch(() => 0)) return true;
  }
  return false;
}

/**
 * Frame konten Storyline. Biasanya `index_lms.html` (lewat player.php), tapi ada pelajaran yang
 * lewat `view.php` dengan URL lain → fallback: frame yang berisi `div[data-acc-text]`.
 */
export async function getScormFrame(page: Page): Promise<Frame | undefined> {
  const byUrl = page.frames().find((f) => f.url().includes("index_lms.html"));
  if (byUrl) return byUrl;
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if (await f.locator("div[data-acc-text]").count().catch(() => 0)) return f;
  }
  return undefined;
}

async function visibleItems(frame: Frame): Promise<Item[]> {
  const out: Item[] = [];
  for (const el of await frame.$$("div[data-acc-text]")) {
    const info = await el.evaluate((e) => ({
      // \r / baris baru di data-acc-text bikin log & prompt berantakan → satu spasi
      text: (e.getAttribute("data-acc-text") ?? "").replace(/\s+/g, " ").trim(),
      vis: (e as any).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true,
    }));
    if (info.vis && info.text) out.push({ text: info.text, el });
  }
  return out;
}

// Judul bisa "Pikirkan" atau "PIKIRKAN" (course-lesson/128) → case-insensitive
const isPikirkan = (t: string[]) => t.some((x) => /^pikirkan$/i.test(x)) && t.some((x) => /^kirim$/i.test(x));

/**
 * Slide pertanyaan tanpa judul "PIKIRKAN" (Pasca kelas "Praktikkan", skenario bercabang, terverifikasi 13.05):
 * ada teks berakhiran "?" atau instruksi "Pilih …", plus minimal 2 teks lain (opsi).
 */
function isQuestion(items: Item[]) {
  const c = candidatesOf(items).map((i) => i.text);
  const q = c.filter((t) => /\?$/.test(t) || /^pilih\s/i.test(t));
  return q.length > 0 && c.length - q.length >= 2;
}

/** Teks yang relevan buat AI: buang noise & feedback. */
const candidatesOf = (items: Item[]) =>
  // >= 3 huruf: nama orang pendek ("Jay", "Sia") itu opsi jawaban (course-lesson/128 Praktikkan, 13.33)
  items.filter((i) => i.text.length >= 3 && !NOISE.test(i.text) && !FEEDBACK.test(i.text));

/** Kunci unik per soal = gabungan teks kandidat (bukan cuma teks berakhiran "?"). */
// Cuma 3 teks pertama: teks feedback/centang yang muncul setelah Kirim (biasanya di akhir DOM) nggak ngubah kunci.
// (13.54: 12 → 16 teks setelah Kirim → dikira soal baru → opsi diklik ulang = pilihan kebatal)
const keyOf = (items: Item[]) =>
  candidatesOf(items)
    .slice(0, 3)
    .map((i) => i.text)
    .join("|");

function countToPick(texts: string[]) {
  for (const t of texts) {
    // "Pilih tiga jawaban…" (Pikirkan) / "Pilih dua opsi…" (Praktikkan)
    const m = t.toLowerCase().match(/\bpilih(?:lah)?\s+(\w+)\s+(jawaban|opsi|pilihan|pernyataan|tindakan|langkah)\b/);
    if (m) return NUM_WORDS[m[1]] ?? (parseInt(m[1]) || 1);
  }
  return 1;
}

async function canNext(frame: Frame) {
  const next = frame.locator("#next");
  return (await next.isVisible().catch(() => false)) &&
    (await next.isEnabled().catch(() => false)) &&
    (await next.getAttribute("aria-disabled").catch(() => null)) !== "true";
}

async function clickNext(frame: Frame, why: string) {
  log(`${why} → Next`);
  await frame.locator("#next").click();
  await sleep(1500);
}

/**
 * Soal menu tarik-turun (Storyline, TANPA `<select>`, recon 13.53): tiap baris punya panah "down arrow icon 1".
 * Cara: klik panah baris 1 → teks baru yang muncul = opsi daftar → AI tentuin jawaban per baris →
 * per baris: klik panah, klik opsi terdekat di bawah panah itu → Kirim.
 * Kalau opsi nggak kebaca: tandai `blocked` (jangan Next otomatis), biar diisi manual.
 */
async function answerDropdown(
  frame: Frame,
  items: Item[],
  done: Set<string>,
  blocked: Set<string>,
  context: string[],
  tried: Map<string, string[][]>,
) {
  const key = keyOf(items);
  done.add(key); // dibuka lagi kalau salah & masih ada "Coba Lagi" (lihat bawah)
  const prev = tried.get(key) ?? [];
  const cands = candidatesOf(items).map((c) => c.text);
  const question = cands.find((t) => /\?$/.test(t)) ?? cands[0] ?? "";
  const rowsText = cands.filter((t) => /^\d+\.\s/.test(t)).sort((a, b) => parseInt(a) - parseInt(b));

  const withY = async (list: Item[]) =>
    (await Promise.all(list.map(async (it) => ({ it, box: await it.el.boundingBox().catch(() => null) }))))
      .filter((x) => x.box)
      .map((x) => ({ it: x.it, y: x.box!.y, x: x.box!.x }));
  const arrows = (await withY(items.filter((i) => /^down arrow icon/i.test(i.text)))).sort((a, b) => a.y - b.y);
  log(`[dropdown] soal: ${question.slice(0, 90)} | baris: ${rowsText.length} | panah: ${arrows.length}`);

  const fail = (why: string) => {
    blocked.add(key);
    log(`⚠ Dropdown: ${why} → isi manual di browser, bot nunggu (nggak klik Next)`);
  };
  if (!arrows.length) return fail("panah nggak ketemu");

  // Opsi daftar = elemen tepat di bawah panah & sejajar kotak dropdown (panah di ujung kanan kotak).
  // Pakai posisi, bukan teks: opsinya "1".."4" (terverifikasi 13.59) yang kena filter noise angka.
  const listUnder = async (arrow: { y: number; x: number }) => {
    const near = (await withY(await visibleItems(frame)))
      .filter((o) => o.x >= arrow.x - 320 && o.x <= arrow.x + 30)
      .filter((o) => !/^down arrow icon/i.test(o.it.text) && !/\.(png|jpe?g|svg)$|^(Rectangle|Group|Oval)/i.test(o.it.text));
    const below = near.filter((o) => o.y > arrow.y + 5 && o.y < arrow.y + 260);
    // Baris paling bawah: daftar bisa kebuka ke ATAS kalau ruang di bawah nggak cukup
    const list = below.length ? below : near.filter((o) => o.y < arrow.y - 5 && o.y > arrow.y - 260);
    return list.sort((a, b) => a.y - b.y);
  };

  // Buka dropdown baris 1 → baca opsinya
  await arrows[0].it.el.click({ force: true });
  await sleep(1000);
  const options = [...new Set((await listUnder(arrows[0])).map((o) => o.it.text))];
  log(`[dropdown] opsi setelah klik panah 1: ${JSON.stringify(options).slice(0, 300)}`);
  await arrows[0].it.el.click({ force: true }).catch(() => {}); // tutup lagi
  await sleep(600);
  if (options.length < 2) return fail("opsi daftar nggak kebaca (bukan teks data-acc-text?)");

  const rows = arrows.map((_, k) => ({ label: rowsText[k] ?? `Baris ${k + 1}`, options }));
  let ans: string[];
  try {
    ans = await pickDropdowns(question, rows, context, prev);
  } catch (e) {
    return fail(String(e).slice(0, 120));
  }

  for (let k = 0; k < arrows.length; k++) {
    const cur = (await withY((await visibleItems(frame)).filter((i) => /^down arrow icon/i.test(i.text)))).sort(
      (a, b) => a.y - b.y,
    )[k];
    if (!cur) return fail(`panah baris ${k + 1} hilang`);
    await cur.it.el.click({ force: true });
    await sleep(800);
    // Opsi yang cocok di daftar bawah panah ini
    const opts = (await listUnder(cur)).filter((o) => o.it.text === ans[k]);
    if (!opts.length) return fail(`opsi "${ans[k]}" nggak muncul di baris ${k + 1}`);
    log(`[dropdown] ${rows[k].label.slice(0, 50)} → ${ans[k]}`);
    await opts[0].it.el.click({ force: true });
    await sleep(600);
  }

  await items.find((i) => /^kirim$/i.test(i.text))?.el.click({ force: true });
  for (let t = 0; t < 6; t++) {
    await sleep(1000);
    const after = await visibleItems(frame);
    if (after.some((a) => CORRECT.test(a.text))) return log("✅ Benar");
    const w = after.find((a) => WRONG.test(a.text));
    if (w) {
      log(`❌ Salah (${w.text.slice(0, 80)})`);
      tried.set(key, [...prev, ans]);
      // Feedback salah sering ngasih petunjuk, tapi teks lengkapnya cuma di gambar (data-acc-text kepotong,
      // 14.06: "…yang harusd") → baca layar sebelum overlay ditutup
      await readScreenIntoContext(frame, context, `feedback salah percobaan ${prev.length + 1}`);
      // Coba lagi kalau ada tombol "Coba Lagi" (dismissFeedback yang klik); maks 3 percobaan per soal
      if (after.some((a) => /^coba lagi$/i.test(a.text)) && prev.length + 1 < 3) done.delete(key);
      return;
    }
  }
  log("❔ Feedback dropdown nggak kebaca");
}

/** Layer feedback (Benar/Belum tepat) lagi tampil? Tutup dulu sebelum baca soal. Return true kalau ada yang ditutup. */
async function dismissFeedback(frame: Frame, items: Item[]) {
  if (!items.some((i) => CORRECT.test(i.text) || WRONG.test(i.text))) return false;
  const btn = items.find((i) => CLOSE_BTN.test(i.text));
  if (!btn) return false;
  log(`Tutup feedback → "${btn.text}"`);
  await btn.el.click({ force: true });
  await sleep(1500);
  return true;
}

async function answerPikirkan(
  frame: Frame,
  items: Item[],
  wrong: Map<string, string[][]>,
  done: Set<string>,
  context: string[],
) {
  const key = keyOf(items);
  const cands = candidatesOf(items);
  const texts = items.map((i) => i.text);
  const attempts = Number(texts.find((t) => /^\d+$/.test(t)) ?? "1");
  const n = countToPick(texts);
  const label = cands
    .filter((c) => !/^(bacalah|klik|pilih|identifikasi|silah?kan)/i.test(c.text))
    .map((c) => c.text)
    .join(" / ")
    .slice(0, 200);

  if (attempts <= 0) {
    log(`Percobaan habis: "${label}" → lanjut`);
    done.add(key);
    return;
  }

  const tried = wrong.get(key) ?? [];
  log(`Soal: ${label} | ${cands.length} teks, pilih ${n}, sisa ${attempts}`);
  const instructions = cands.filter(c => /^(?:bacalah|pilih(?:lah)?|klik|identifikasi|tinjaulah)\b/i.test(c.text));
  const pool = cands.filter(c => !instructions.includes(c));
  const choices = pool.length >= n && pool.length >= 2 ? pool : cands;
  const ask = () => pickAnswers(choices.map(c => c.text), n, tried, [...context, ...instructions.map(c => c.text)]);
  let chosen = await ask();
  const repeatsWrong = (indices: number[]) => tried.some(group => group.length === indices.length && indices.every(i => group.includes(choices[i-1]?.text)));
  if (repeatsWrong(chosen)) {
    log('AI mengulang kombinasi yang sudah salah → evaluasi ulang sebelum klik');
    chosen = await ask();
    if (repeatsWrong(chosen)) throw new Error('AI mengulang jawaban salah; percobaan tidak digunakan');
  }
  const picks = chosen.map(i => cands.indexOf(choices[i-1]) + 1);
  const pickedTexts = picks.map((p) => cands[p - 1].text);
  log(`AI pilih: ${pickedTexts.join(" | ")}`);

  for (const p of picks) {
    await cands[p - 1].el.click({ force: true });
    await sleep(400);
  }
  const kirim = items.find((i) => /^kirim$/i.test(i.text));
  if (!kirim) {
    // Slide pilihan skenario: klik opsi langsung lanjut ke cabang berikutnya, nggak ada feedback benar/salah
    log("Pilihan diklik (tanpa Kirim)");
    done.add(key);
    await sleep(2000);
    return;
  }
  await kirim.el.click({ force: true });

  // Tunggu feedback muncul (maks ~6 detik)
  let after: Item[] = [];
  let result: "benar" | "salah" | "?" = "?";
  for (let i = 0; i < 6 && result === "?"; i++) {
    await sleep(1000);
    after = await visibleItems(frame);
    // Salah menang kalau dua-duanya kelihatan. ("Bagus!" + tombol "Lanjutkan" = BENAR, terverifikasi 12.08
    // lewat screenshot feedback Praktikkan 148 — "Lanjutkan" bukan cuma milik overlay salah)
    const w = after.find((a) => WRONG.test(a.text));
    const c = after.find((a) => CORRECT.test(a.text));
    if (w) result = "salah";
    else if (c) result = "benar";
  }
  if (result === "benar") {
    log(`✅ Benar (${after.find((a) => CORRECT.test(a.text))?.text.slice(0, 60)})`);
    done.add(key);
  } else if (result === "salah") {
    log(`❌ Salah (${after.find((a) => WRONG.test(a.text))?.text})`);
    wrong.set(key, [...tried, pickedTexts]);
    if (after.some((a) => /^coba lagi$/i.test(a.text))) {
      // Masih ada percobaan → baca teks feedback lengkap (gambar) buat petunjuk
      await readScreenIntoContext(frame, context, `feedback salah`);
    }
  } else {
    log(`❔ Feedback nggak kebaca → anggap terjawab (jangan klik ulang opsi). Teks: ${JSON.stringify(after.map((a) => a.text).slice(0, 12)).slice(0, 300)}`);
    done.add(key);
  }

  // Layer feedback: tombol "Selesai"/"Coba lagi"/"Lanjutkan", atau minta klik SELANJUTNYA
  if (!(await dismissFeedback(frame, after)) && result === "benar" && (await canNext(frame))) {
    await clickNext(frame, "Feedback minta SELANJUTNYA");
  }
}

// Player bisa bahasa Inggris atau Indonesia (course-lesson/129: "kemajuan slide", "Mainkan (Ctrl+Alt+P)")
const PROGRESS_SEL = 'input[aria-label="slide progress"], input[aria-label="kemajuan slide"]';
const PAUSED_LABEL = /^(Play|Mainkan)/i;

/** `max` = NaN kalau nggak ada aria-valuemax / atribut max (jangan ditebak). */
async function slideProgress(frame: Frame) {
  return frame
    .$eval(PROGRESS_SEL, (el) => {
      const i = el as HTMLInputElement;
      return {
        v: Number(i.getAttribute("aria-valuenow") ?? i.value),
        max: Number(i.getAttribute("aria-valuemax") ?? i.getAttribute("max") ?? NaN),
        found: true,
      };
    })
    .catch(() => ({ v: 0, max: NaN, found: false }));
}

async function isPaused(frame: Frame) {
  const label = (await frame.locator("#play-pause").getAttribute("aria-label").catch(() => "")) ?? "";
  return PAUSED_LABEL.test(label);
}

/** Recon kontrol player dari frame yang dipakai bot (progress/play/next beda antar pelajaran). */
async function playerDiag(frame: Frame) {
  // Skrip sebagai string: fungsi biasa di evaluate() kena helper `__name` dari tsx → ReferenceError
  const script = `(() => {
    const sel = "#play-pause, #next, #prev, input[type=range], [role=slider], [role=progressbar], button[aria-label], [class*=progress]";
    const ctl = Array.from(document.querySelectorAll(sel)).slice(0, 15).map((e) => ({
      tag: e.tagName.toLowerCase(), id: e.id || undefined,
      cls: (e.getAttribute("class") || "").slice(0, 50) || undefined,
      aria: e.getAttribute("aria-label") || undefined, role: e.getAttribute("role") || undefined,
      now: e.getAttribute("aria-valuenow") ?? e.value, max: e.getAttribute("aria-valuemax") || undefined,
      dis: e.getAttribute("aria-disabled") || (e.disabled ? "true" : undefined),
    }));
    // Dialog/prompt player (mis. "lanjutkan dari terakhir?") nggak punya data-acc-text → cari teks tombol & jendela pesan
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dialog = Array.from(document.querySelectorAll("[class*=prompt], [class*=message], [class*=dialog], [class*=modal], [role=dialog], [role=alertdialog]"))
      .filter(vis).slice(0, 5).map((e) => ((e.id ? "#" + e.id + " " : "") + (e.getAttribute("class") || "").slice(0, 40) + " :: " + (e.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 120)));
    const buttons = Array.from(document.querySelectorAll("button, [role=button]")).filter(vis)
      .map((b) => (b.id ? "#" + b.id + " " : "") + ((b.innerText || "").trim() || b.getAttribute("aria-label") || "")).filter((t) => t).slice(0, 20);
    return JSON.stringify({ url: location.pathname.split("/").slice(-2).join("/"), dialog, buttons, ctl });
  })()`;
  return frame.evaluate(script).catch((e) => `gagal: ${e}`);
}


/**
 * Slide "Klik ikon <x> untuk …": klik elemen yang namanya cocok sama ikon itu (sekali per elemen).
 * Kalau nggak ketemu, tulis semua teks mentah (termasuk noise) sekali buat recon.
 */
/**
 * Screenshot frame Storyline → AI baca isinya → masuk konteks soal berikutnya.
 * Dipakai buat popup yang isinya gambar (surel di Praktikkan course-lesson/128 nggak ada di data-acc-text).
 */
async function readScreenIntoContext(frame: Frame, context: string[], why: string) {
  try {
    const el = await frame.frameElement();
    const png = await el.screenshot();
    const text = (await describeImage(png)).replace(/\s+/g, " ").slice(0, 1500);
    if (text) {
      context.push(`[${why}] ${text}`);
      if (context.length > 8) context.splice(0, context.length - 8);
      log(`[gambar] ${why}: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
    }
  } catch (e) {
    log(`[gambar] gagal baca layar: ${String(e).slice(0, 120)}`);
  }
}

async function clickHintIcon(
  frame: Frame,
  items: Item[],
  clicked: Set<string>,
  logged: Set<string>,
  context: string[],
  described: Set<string>,
  eachState: { names: string[]; done: boolean; tries: Record<string, number> },
) {
  // Popup (mis. surel) dengan "Klik untuk menutup" + tombol X = "wrong.png" (terverifikasi 13.39) → baca, lalu tutup
  if (items.some((i) => /^klik untuk menutup$/i.test(i.text))) {
    const x = items.find((i) => /^wrong\.png$|^close|^tutup/i.test(i.text));
    if (x) {
      const popupKey = items.map((i) => i.text).join("|");
      if (!described.has(popupKey)) {
        described.add(popupKey);
        await sleep(1500); // tunggu animasi popup selesai sebelum screenshot
        await readScreenIntoContext(frame, context, "isi popup");
      }
      log(`Tutup popup → klik "${x.text}"`);
      await x.el.click({ force: true });
      await sleep(2500);
      return true;
    }
  }
  // "Klik pada setiap …": target = teks pendek di slide (nama orang/label), satu per satu
  // Target diingat dari saat petunjuk pertama kelihatan: popup perspektif bisa nutup petunjuknya
  // (12.02: setelah klik Monica petunjuk hilang → Next → Kris & Rita nggak pernah dibuka)
  const each = items.find((i) => HINT_EACH.test(i.text));
  if (each && !eachState.names.length && !eachState.done) {
    eachState.names = [
      ...new Set(
        candidatesOf(items)
          .filter(
            (i) => i !== each && i.text.length <= 30 && !/^klik|^pilih|^silah?kan/i.test(i.text) && !/\s.*\s.*\s/.test(i.text),
          )
          .map((i) => i.text),
      ),
    ];
    log(`Petunjuk "${each.text.slice(0, 60)}" → target: ${eachState.names.join(", ") || "(nggak ada)"}`);
    if (!eachState.names.length) {
      eachState.done = true;
      log(`[diag] target nggak ketemu. Semua teks: ${JSON.stringify(items.map((i) => i.text)).slice(0, 600)}`);
    }
  }
  if (eachState.names.length && !eachState.done) {
    const pending = eachState.names.filter((n) => !clicked.has(`each|${n}`));
    if (!pending.length) {
      const x = items.find((i) => CLOSE_ICON.test(i.text));
      if (x) {
        log(`Tutup popup terakhir → klik "${x.text}"`);
        await x.el.click({ force: true });
        await sleep(1500);
        return true;
      }
      eachState.done = true;
      log("Semua target petunjuk sudah dibuka");
      return false;
    }
    const target = items.find((i) => pending.includes(i.text));
    if (!target) {
      // Target ketutup popup perspektif → tutup pakai tombol X ("close button illustration 1.png", recon 12.10)
      const x = items.find((i) => CLOSE_ICON.test(i.text));
      if (x) {
        log(`Tutup popup → klik "${x.text}"`);
        await x.el.click({ force: true });
        await sleep(1500);
        return true;
      }
    }
    if (target) {
      const n = (eachState.tries[target.text] = (eachState.tries[target.text] ?? 0) + 1);
      // Klik pertama nunggu slide tenang dulu (12.08 & 12.14: Monica diklik pas petunjuk baru muncul → nggak kebuka)
      if (n === 1 && pending.length === eachState.names.length) await sleep(2000);
      log(`→ klik "${target.text}" (${eachState.names.length - pending.length + 1}/${eachState.names.length}${n > 1 ? `, coba ke-${n}` : ""})`);
      await target.el.click({ force: true });
      await sleep(2500);
      // Pastikan popup perspektif kebuka (tombol X / teks "Perspektif …"); kalau nggak, ulang (maks 3×)
      const after = await visibleItems(frame);
      const opened = after.some((i) => CLOSE_ICON.test(i.text) || /^perspektif\b/i.test(i.text));
      if (!opened && n < 3) {
        log(`⚠ Klik "${target.text}" nggak membuka popup → ulang`);
        return true;
      }
      if (!opened) log(`⚠ "${target.text}" tetap nggak kebuka setelah 3× → lanjut`);
      clicked.add(`each|${target.text}`);
      await readScreenIntoContext(frame, context, `setelah klik "${target.text}"`);
      return true;
    }
    return false; // target lagi ketutup popup → tunggu (Next diblokir di loop utama)
  }

  const hint = items.find((i) => HINT_ICON.test(i.text));
  if (!hint) return false;
  const word = hint.text.match(HINT_ICON)![1].toLowerCase();
  if (word === "audio") return false; // ikon audio di slide soal: opsional
  const pat = ICON_TARGET[word];
  const matches = pat ? items.filter((i) => i !== hint && pat.test(i.text)) : [];
  // Kunci = teks + urutan: ada beberapa ikon bernama sama (2× "i" di label Internal/Eksternal, 13.46)
  const keyed = matches.map((m, idx) => ({ m, k: `${word}|${m.text}#${idx}` }));
  const next = keyed.find((x) => !clicked.has(x.k));
  if (matches.length && !next) return false; // ikonnya sudah diklik semua, petunjuknya cuma masih kelihatan
  if (next) {
    clicked.add(next.k);
    log(`Petunjuk "${hint.text.slice(0, 60)}" → klik "${next.m.text}" (${keyed.indexOf(next) + 1}/${keyed.length})`);
    await next.m.el.click({ force: true });
    await sleep(2500);
    // Ikon informasi buka penjelasan (gambar) → baca buat konteks soal berikutnya.
    // Surel nggak di sini: popup-nya punya "Klik untuk menutup" dan dibaca di cabang atas.
    if (word !== "surel") await readScreenIntoContext(frame, context, `setelah klik ikon ${word} ${keyed.indexOf(next) + 1}`);
    return true;
  }
  if (!logged.has(hint.text)) {
    logged.add(hint.text);
    log(`[diag] petunjuk "${hint.text.slice(0, 60)}" tapi ikon nggak ketemu. Semua teks: ${JSON.stringify(items.map((i) => i.text)).slice(0, 600)}`);
  }
  return false;
}

/**
 * Menu skenario: klik situasi pertama yang belum dibuka, lalu PASTIKAN slide pindah (teks menu hilang).
 * 14.45 (course-lesson/144): klik teks "Situasi N" nggak ngapa-ngapain → bot klik ketiganya → Next → Hasil 0%.
 * Kalau slide nggak pindah: menu ditandai gagal → `menuBlocked()` mencegah Next di slide ini.
 * Return true kalau ada aksi (klik/berhasil masuk situasi).
 */
async function openMenuItem(frame: Frame, items: Item[], visited: Set<string>, failed: Set<string>) {
  const menu = items.filter((i) => MENU_ITEM.test(i.text));
  if (menu.length < 2) return false;
  const menuKey = menu.map((m) => m.text).join("|");
  if (failed.has(menuKey)) return false;
  const next = menu.find((i) => !visited.has(i.text));
  if (!next) return false; // semua situasi sudah dikerjakan → boleh Next
  log(`Menu skenario → buka "${next.text.slice(0, 80)}" (${visited.size + 1}/${menu.length})`);
  await next.el.click({ force: true });
  for (let t = 0; t < 8; t++) {
    await sleep(1000);
    const now = (await visibleItems(frame)).map((i) => i.text);
    if (!now.includes(next.text)) {
      visited.add(next.text);
      return true; // masuk ke situasi
    }
  }
  failed.add(menuKey);
  log(`⚠ Klik "${next.text.slice(0, 50)}" nggak membuka situasi → bot NGGAK akan klik Next di menu ini (kerjakan manual)`);
  log(`[diag] menu: ${await playerDiag(frame)}`);
  return true;
}

/** Slide menu skenario yang belum semua situasinya dibuka → jangan Next (biar nggak lompat ke Hasil 0%). */
function menuBlocked(items: Item[], visited: Set<string>) {
  const menu = items.filter((i) => MENU_ITEM.test(i.text));
  return menu.length >= 2 && menu.some((m) => !visited.has(m.text));
}

async function ensurePlaying(frame: Frame, progressV: number) {
  if (progressV > 0) return;
  if (await isPaused(frame)) await frame.locator("#play-pause").click().catch(() => {});
}

/**
 * Jalanin satu item SCORM sampai `isDone()` true (item tercentang di sidebar)
 * atau nggak ada perubahan selama `stuckMs`.
 */
export async function runScorm(
  page: Page,
  isDone: () => Promise<boolean>,
  stuckMs = 90_000,
  endMs = 15_000,
): Promise<"done" | "end" | "stuck"> {
  const wrong = new Map<string, string[][]>();
  const done = new Set<string>();
  let lastChange = Date.now();
  let lastSig = "";
  let endSince = 0; // sejak kapan slide selesai + Next mati (kemungkinan slide terakhir)
  let diagLogged = false;
  let startClickedSig = ""; // biar "Mulai" nggak diklik berulang di slide yang sama
  let lastTextsKey = ""; // buat log [slide] tiap isi slide berubah
  const iconClicked = new Set<string>(); // ikon yang sudah diklik (per teks elemen)
  const hintLogged = new Set<string>();
  const described = new Set<string>(); // popup yang sudah di-screenshot & dibaca AI
  const eachState = { names: [] as string[], done: false, tries: {} as Record<string, number> }; // "Klik pada setiap …"
  const blocked = new Set<string>(); // soal yang gagal diisi bot → jangan Next otomatis
  const menuVisited = new Set<string>(); // item menu skenario yang sudah dibuka (terverifikasi pindah slide)
  const menuFailed = new Set<string>(); // menu yang kliknya nggak berfungsi
  const triedDropdown = new Map<string, string[][]>(); // jawaban dropdown yang sudah salah
  let lastV = -1;
  let vSince = Date.now(); // sejak kapan nilai progress nggak berubah
  // Teks cerita/skenario dari slide non-soal (mis. "Monica bekerja di SDM…") → konteks buat AI
  const context: string[] = [];

  while (true) {
    if (await contentExited(page)) {
      log("Konten keluar (konten sudah habis)");
      return "end";
    }
    const frame = await getScormFrame(page);
    if (!frame) {
      if (!diagLogged && Date.now() - lastChange > 10_000) {
        diagLogged = true;
        log(`[diag] frame Storyline nggak ketemu. Frame: ${page.frames().map((f) => f.url().split("?")[0] || "(kosong)").join(" , ")}`);
        // Per frame: jumlah elemen Storyline, iframe anak, dan tombol (buat nyari tombol Play besar)
        for (const f of page.frames()) {
          const info = await f
            .evaluate(`JSON.stringify({
              acc: document.querySelectorAll("div[data-acc-text]").length,
              iframes: Array.from(document.querySelectorAll("iframe")).map((i) => (i.id || "") + ":" + (i.getAttribute("src") || "").split("?")[0].slice(-60)),
              btn: Array.from(document.querySelectorAll("button, [role=button]")).slice(0, 8).map((b) => (b.id ? "#" + b.id + " " : "") + (b.getAttribute("aria-label") || b.innerText || "").trim().slice(0, 30)),
              teks: (document.body && document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 120),
            })`)
            .catch((e) => `gagal: ${String(e).slice(0, 80)}`);
          log(`[diag]   ${f.url().split("?")[0].slice(-60) || "(kosong)"} → ${info}`);
        }
      }
      if (Date.now() - lastChange > stuckMs) return "stuck";
      await sleep(1000);
      continue;
    }

    // Dialog bawaan player "Lanjutkan / Mulai ulang" (konten pernah dibuka sebelumnya, terverifikasi 14.36,
    // Praktikkan course-lesson/140). Bukan data-acc-text → cari teks tombolnya langsung. Pilih "Mulai ulang":
    // mulai dari slide judul lebih bisa ditangani bot daripada lanjut di tengah video/soal.
    const restart = frame.getByText(/^(mulai ulang|start over|restart)$/i).first();
    if (await restart.isVisible().catch(() => false)) {
      log('Dialog lanjutkan → klik "Mulai ulang"');
      await restart.click({ force: true }).catch(() => {});
      await sleep(3000);
      continue;
    }

    const items = await visibleItems(frame);
    const texts = items.map((i) => i.text);
    // Progres video ikut dihitung, biar video panjang nggak dianggap macet
    const prog = await slideProgress(frame);
    const sig = texts.join("|") + "#" + prog.v;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = Date.now();
      diagLogged = false;
    }
    // Diagnostik: slide diam 20 detik → tulis teks yang kelihatan (buat recon soal yang nggak dikenali)
    if (!diagLogged && Date.now() - lastChange > 20_000) {
      diagLogged = true;
      log(`[diag] slide diam 20 dtk, progress ${prog.v}/${prog.max} (found=${prog.found}), pikirkan=${isPikirkan(texts)}, teks: ${JSON.stringify(texts.slice(0, 15)).slice(0, 400)}`);
      log(`[diag] player: ${await playerDiag(frame)}`);
    }

    // Recon: cetak teks slide tiap kali isinya berubah (skenario bercabang belum dikenali)
    // Log cuma teks yang BARU muncul (+) biar perubahan di ujung slide panjang tetap kelihatan
    const curTexts = candidatesOf(items).map((c) => c.text);
    const textsKey = curTexts.join(" / ");
    if (textsKey !== lastTextsKey) {
      const prevSet = new Set(lastTextsKey.split(" / "));
      const added = curTexts.filter((t) => !prevSet.has(t));
      lastTextsKey = textsKey;
      if (added.length) log(`[slide] + ${added.join(" / ").slice(0, 300)}`);
    }

    if (prog.v !== lastV) {
      lastV = prog.v;
      vSince = Date.now();
    }
    const paused = await isPaused(frame);
    // Selesai: progress ≥ max, ATAU player pause + progress > 0 + diam 3 detik.
    // (course-lesson/129: slide intro berhenti di 200/250 dalam keadaan pause, bar di layar sudah penuh)
    const finished =
      prog.found &&
      ((Number.isFinite(prog.max) && prog.v >= prog.max - 0.5) ||
        (paused && prog.v > 0 && Date.now() - vSince > 3000));

    const pik = isPikirkan(texts) || isQuestion(items);
    if (!pik) {
      for (const c of candidatesOf(items)) {
        // teks petunjuk ("Klik …", "Pilih …") bukan konteks cerita
        if (c.text.length > 60 && !/^(klik|pilih|silah?kan)\s/i.test(c.text) && !context.includes(c.text)) context.push(c.text);
      }
      if (context.length > 8) context.splice(0, context.length - 8);
    }

    let atEnd = false;
    const startBtn = items.find((i) => START_BTN.test(i.text));
    const playImg = texts.some((t) => PLAY_HINT.test(t)) ? items.find((i) => PLAY_IMG.test(i.text)) : undefined;
    const scoreIdx = texts.findIndex((t) => RESULTS.test(t));
    const keluar = texts.some((t) => EXPLORE_LINKS.test(t)) ? items.find((i) => /^keluar$/i.test(i.text)) : undefined;
    if (keluar) {
      log('Halaman tautan Eksplorasi → klik "Keluar"');
      await keluar.el.click({ force: true });
      await sleep(3000);
      return "end";
    }
    if (scoreIdx >= 0) {
      // Slide hasil: catat skor, anggap item selesai (centang muncul setelah pindah item)
      log(`Hasil: ${texts.slice(scoreIdx, scoreIdx + 4).join(" ")}`);
      await sleep(5000); // kasih waktu konten commit status sendiri sebelum pindah item
      return "end";
    }
    const outcome = items.find((i) => OUTCOME.test(i.text));
    const selesai = items.find((i) => /^selesai$/i.test(i.text));
    if (outcome && selesai) {
      // Layar hasil skenario: jangan "Coba Lagi" (bot belum bisa milih cabang) → Selesai
      log(`Hasil skenario: "${outcome.text.slice(0, 120)}" → Selesai`);
      await selesai.el.click({ force: true });
      await sleep(2000);
    } else if (await dismissFeedback(frame, items)) {
      // overlay feedback ditutup, baca ulang slide di putaran berikutnya
    } else if (!pik && (await clickHintIcon(frame, items, iconClicked, hintLogged, context, described, eachState))) {
      // ikon dari petunjuk "Klik ikon …" sudah diklik, baca ulang slide
    } else if (!pik && (await openMenuItem(frame, items, menuVisited, menuFailed))) {
      // masuk ke situasi berikutnya dari menu skenario
    } else if (playImg && startClickedSig !== sig) {
      startClickedSig = sig;
      log(`Klik tombol play (${playImg.text})`);
      await playImg.el.click({ force: true });
      await sleep(2000);
    } else if (startBtn && startClickedSig !== sig) {
      startClickedSig = sig;
      log(`Klik "${startBtn.text}"`);
      await startBtn.el.click({ force: true });
      await sleep(2000);
    } else if (texts.some((t) => /klik selanjutnya/i.test(t)) && !texts.some((t) => /^kirim$/i.test(t)) && (await canNext(frame))) {
      // Setelah percobaan habis, konten nunjukin jawaban benar + "Klik SELANJUTNYA…"
      await clickNext(frame, "Konten minta SELANJUTNYA");
    } else if (pik) {
      if (!done.has(keyOf(items))) {
        if (texts.some((t) => DROPDOWN_HINT.test(t))) await answerDropdown(frame, items, done, blocked, context, triedDropdown);
        else await answerPikirkan(frame, items, wrong, done, context);
      }
      else if (blocked.has(keyOf(items))) {
        // dropdown gagal diisi bot → tunggu pengguna isi manual (jangan Next)
      } else if (await canNext(frame)) await clickNext(frame, "Soal sudah dijawab");
      else atEnd = true;
    } else if (!pik && eachState.names.length && !eachState.done) {
      // masih ada target "Klik pada setiap …" yang belum dibuka (mungkin ketutup popup) → JANGAN Next
    } else if (!pik && menuBlocked(items, menuVisited)) {
      // menu skenario belum beres & klik situasi gagal → tunggu manual, JANGAN Next
    } else if (finished) {
      // Jangan klik Play di sini: di akhir timeline Play = putar ulang slide (loop tanpa akhir)
      if (await canNext(frame)) await clickNext(frame, "Slide selesai");
      // Slide soal (ada "Kirim") yang nggak dikenali: Next mati karena belum dijawab, BUKAN slide terakhir
      // Slide dengan tombol "Mulai" juga bukan slide terakhir
      else atEnd = !texts.some((t) => /kirim/i.test(t) || START_BTN.test(t));
    } else {
      await ensurePlaying(frame, prog.v);
    }

    if (await isDone().catch(() => false)) return "done";

    if (!atEnd) endSince = 0;
    else if (!endSince) endSince = Date.now();
    else if (Date.now() - endSince > endMs) {
      log(`Kemungkinan slide terakhir (Next mati ${endMs / 1000} detik). Teks: ${texts.slice(0, 8).join(" / ").slice(0, 160)}`);
      return "end";
    }
    if (Date.now() - lastChange > stuckMs) {
      log(`Nggak ada perubahan ${stuckMs / 1000} detik`);
      return "stuck";
    }
    await sleep(1000);
  }
}
