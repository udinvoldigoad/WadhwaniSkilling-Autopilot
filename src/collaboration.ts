import readline from "node:readline/promises";
import type { Frame, Locator, Page } from "playwright";
import { itemDone } from "./nav.js";
import { log } from "./log.js";
import { AiDownError, draftReflection } from "./ai.js";

const visible = (f: Frame, re: RegExp) => f.getByText(re).and(f.locator(":visible"));

async function reflectionFinished(frame: Frame) {
  return await visible(frame, /^skor anda$/i).first().isVisible() &&
    await visible(frame, /klik panah kanan di bawah untuk melanjutkan/i).first().isVisible();
}

// Grid bisa dibuat dengan div. Cocokkan posisi label terhadap baris dan kolom,
// tanpa mengandalkan urutan DOM atau koordinat layar tetap.
async function pairedCard(f: Frame): Promise<Locator | undefined> {
  const row = await visible(f, /^generic workplace$/i).first().boundingBox({ timeout: 500 }).catch(() => null);
  if (!row) return;
  const col = await visible(f, /aktivitas berpasangan/i).first().boundingBox({ timeout: 500 }).catch(() => null);
  if (!col) return;
  const matches: Locator[] = [];
  for (const label of await visible(f, /lihat aktivitas/i).all()) {
    const b = await label.boundingBox({ timeout: 500 }).catch(() => null);
    if (b && b.y < row.y + row.height && row.y < b.y + b.height &&
        b.x < col.x + col.width && col.x < b.x + b.width) matches.push(label);
  }
  if (matches.length === 1) return matches[0];
}

export async function openPairedActivity(page: Page) {
  const end = Date.now() + 30_000;
  let started = false, clicked = false;
  while (Date.now() < end) {
    for (const f of page.frames()) {
      const chat = visible(f, /^keluar dari latihan$/i).first();
      const reflect = visible(f, /^refleksikan aktivitasnya$/i).first();
      if (await chat.isVisible() || await reflect.isVisible() || await reflectionFinished(f)) return { chat, reflect, frame: f };
      if (clicked) continue;
      const card = await pairedCard(f);
      if (card) {
        log("[kolaborasi] Klik Lihat Aktivitas: Generic workplace → Aktivitas Berpasangan (2 orang)");
        // Bila panah punya tombol sendiri, klik tombol di dalam kartu yang sama.
        const cell = card.locator('xpath=ancestor-or-self::*[contains(normalize-space(.), "Lihat Aktivitas") and (descendant::button or descendant::a or descendant::*[@role="button"])][1]');
        const controls = cell.locator('button:visible, a:visible, [role=button]:visible');
        const target = await controls.count() === 1 && await cell.getByText(/lihat aktivitas/i).count() === 1 ? controls.first() : card;
        await target.click({ timeout: 5000 });
        clicked = true;
      } else if (!started) {
        const start = visible(f, /^mulai$/i).first();
        if (await start.isVisible()) { await start.click({ timeout: 5000 }); started = true; }
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(clicked ? "Kartu diklik tetapi detail aktivitas belum muncul" : "Kartu Generic workplace × Aktivitas Berpasangan tidak ditemukan");
}

export async function runCollaboration(page: Page, name: string, draftAnswer = draftReflection): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { chat, reflect, frame } = await openPairedActivity(page);
    if (await reflectionFinished(frame)) return true;
    if (!(await chat.isVisible())) {
      await reflect.waitFor({ timeout: 15_000 });
      await reflect.scrollIntoViewIfNeeded();
      await reflect.click();
    }
    await chat.waitFor({ timeout: 15_000 });
    // Mulai dari header refleksi agar tidak mengisi kotak Tutor Saya di sidebar.
    const boxes = 'textarea:visible, input:not([type]):visible, input[type=text]:visible, [contenteditable=true]:visible';
    const panel = chat.locator('xpath=ancestor::*[not(self::body or self::html)]').filter({ has: frame.locator(boxes) }).last();
    const input = panel.locator(boxes);
    // Setelah memilih konsep, pertanyaan bisa diakhiri label nilai, mis. "? (4 mark)".
    const question = panel.getByText(/(?:\?\s*(?:\(\s*\d+\s*(?:marks?|poin|points?)\s*\))?\s*$|^(?:bagaimana|mengapa|apa(?:kah)?|jelaskan|ceritakan|uraikan|sebutkan|gambarkan|berikan contoh)\b)/i).and(frame.locator(':visible')).last();
    // Instruksi pilihan tidak berakhiran '?' dan belum tentu ada kotak teks.
    const choose = visible(frame, /^pilih(?:lah)?\s+satu konsep\b/i).last();
    let concept = '';
    const sent = new Set<string>();
    const answers = new Set<string>();
    const value = () => input.evaluate(el => String('value' in el ? el.value : el.textContent ?? '').trim());
    let deadline = Date.now() + 30_000;
    while (Date.now() < deadline && sent.size < 20) {
      if (await reflectionFinished(frame) || (sent.size && await itemDone(page, name))) return true;
      if (!concept && await choose.isVisible()) {
        // Cari kelompok opsi tepat setelah gelembung pesan (bisa dibungkus beberapa div).
        const group = choose.locator('xpath=ancestor-or-self::*[not(descendant-or-self::*[normalize-space(.)="Keluar dari latihan"]) ]/following-sibling::*[1][count(*) >= 2]').first();
        const option = group.locator(':scope > :visible').filter({ hasText: /\S/ }).first();
        if (await option.isVisible()) {
          const label = (await option.innerText()).trim();
          if (label && label.length <= 100 && !label.includes('\n') && await option.isEnabled()) {
            await option.click({ timeout: 5000 });
            concept = label;
            log(`[kolaborasi] Pilih konsep: ${concept}`);
            deadline = Date.now() + 30_000;
            continue;
          }
        }
      }
      const prompt = (await question.textContent({ timeout: 500 }).catch(() => ''))?.trim();
      if (!prompt || sent.has(prompt) || answers.has(prompt)) {
        await page.waitForTimeout(400);
        continue;
      }
      if (await input.count() !== 1 || await value()) break;
      log(`[kolaborasi] Membaca refleksi, menunggu jawaban 9Router: ${prompt.slice(0,80)}`);
      const draft = await draftAnswer(concept ? `Konsep yang dipilih: ${concept}\nPertanyaan: ${prompt}` : prompt);
      if ((await question.textContent())?.trim() !== prompt || await value()) break;
      await input.fill(draft);
      const sendName = /^(kirim|send)( (jawaban|pesan|answer|message))?$/i;
      const send = panel.getByRole('button', { name: sendName })
        .or(panel.getByText(sendName)).and(frame.locator(':visible')).first();
      await send.click({ timeout: 10_000 });
      sent.add(prompt);
      answers.add(draft.trim());
      log(`[kolaborasi] Klik Kirim untuk jawaban ${sent.size}; menunggu pertanyaan berikutnya`);
      deadline = Date.now() + 30_000;
    }
    if (await reflectionFinished(frame) || await itemDone(page, name)) return true;
    await rl.question("Belum ada konfirmasi selesai. Periksa refleksi di browser, lalu tekan Enter setelah selesai untuk cek progres...");
    // Pemanggil me-refresh sekali dan memverifikasi progres di sidebar.
    return true;
  } catch (error) {
    if (error instanceof AiDownError) throw error;
    log(`[kolaborasi] ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    rl.close();
  }
}
