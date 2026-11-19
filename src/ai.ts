import OpenAI from "openai";
import { log, sleep } from "./log.js";

const client = new OpenAI({
  baseURL: process.env.AI_BASE_URL,
  apiKey: process.env.AI_API_KEY ?? "none",
  timeout: 60_000,
  maxRetries: 0, // retry diatur sendiri di bawah (biar kelihatan di log)
});

/** AI (9Router) nggak bisa dihubungi setelah beberapa kali coba → run dihentikan rapi. */
export class AiDownError extends Error {}

export async function draftReflection(question: string): Promise<string> {
  const res = await withRetry("refleksi", () => client.chat.completions.create({
    model: process.env.AI_MODEL!,
    messages: [
      { role: "system", content: "Tulis draf jawaban refleksi keterampilan kerja dalam bahasa Indonesia, 2–3 kalimat langsung menjawab pertanyaan. Gunakan pendekatan yang bisa dilakukan, tanpa mengarang pengalaman pribadi. Balas dengan teks jawaban saja." },
      { role: "user", content: question },
    ],
  }));
  const draft = res.choices[0]?.message.content?.trim();
  if (!draft) throw new Error("Model tidak memberikan jawaban refleksi");
  return draft;
}

// Koneksi putus / timeout / server error → layak dicoba ulang. Error lain (mis. 401, model salah) → langsung gagal.
const retryable = (e: any) =>
  e instanceof OpenAI.APIConnectionError || e instanceof OpenAI.APIConnectionTimeoutError || (e?.status ?? 0) >= 500;

const BACKOFF = [5, 10, 20, 30, 60]; // detik, total ±2 menit

/** Bungkus panggilan AI: coba ulang kalau 9Router putus sebentar (mis. lagi di-restart). */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!retryable(e)) throw e;
      if (i >= BACKOFF.length) {
        throw new AiDownError(`AI (${process.env.AI_BASE_URL}) nggak bisa dihubungi: ${e?.message ?? e}`);
      }
      log(`⚠ AI nggak bisa dihubungi (${what}: ${e?.message ?? e}) → coba lagi ${BACKOFF[i]} dtk (${i + 1}/${BACKOFF.length})`);
      await sleep(BACKOFF[i] * 1000);
    }
  }
}

/** Cek 9Router hidup sebelum mulai (tanpa ngabisin token: cuma daftar model). */
export async function checkAi(): Promise<string | null> {
  try {
    await client.models.list();
    return null;
  } catch (e: any) {
    if (retryable(e)) return `nggak bisa terhubung ke ${process.env.AI_BASE_URL} (${e?.message ?? e})`;
    // 401/404 dsb. di /models belum tentu berarti chat gagal (endpoint opsional) → anggap hidup
    return null;
  }
}

/**
 * `texts` = semua teks yang kelihatan di slide (instruksi, soal/pernyataan, opsi).
 * AI yang menentukan mana opsi jawaban, lalu return nomornya (1-based) sebanyak `n`.
 * `avoid` = kombinasi (teks opsi) yang sudah terbukti salah. Pakai teks, bukan nomor:
 *   daftar teks bisa berubah urutan/jumlah antar percobaan.
 */
export async function pickAnswers(
  texts: string[],
  n: number,
  avoid: string[][] = [],
  context: string[] = [],
): Promise<number[]> {
  const options = texts;
  const list = texts.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const avoidTxt = avoid.length
    ? `\nKombinasi berikut SUDAH DICOBA dan SALAH, jangan diulang: ${avoid.map((a) => `[${a.map((t) => `"${t}"`).join(", ")}]`).join("; ")}`
    : "";

  const res = await withRetry("jawab", () => client.chat.completions.create({
    model: process.env.AI_MODEL!,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Kamu menjawab soal pilihan ganda materi keterampilan kerja (soft skills). " +
          'Balas HANYA JSON: {"jawaban":[nomor,...]}',
      },
      {
        role: "user",
        content:
          (context.length ? `Konteks/skenario dari slide sebelumnya:\n${context.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
          `Berikut teks yang terlihat di slide kuis, bernomor. Sebagian adalah instruksi/soal/pernyataan, ` +
          `sebagian adalah opsi jawaban yang bisa diklik.\n\n${list}\n\n` +
          `Pilih tepat ${n} nomor OPSI JAWABAN yang benar (jangan pilih instruksi/soal).${avoidTxt}`,
      },
    ],
  }));

  const raw = res.choices[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  const nums: number[] = m ? (JSON.parse(m[0]).jawaban ?? []) : [];
  const valid = [...new Set(nums.map(Number))].filter((x) => x >= 1 && x <= options.length);
  if (valid.length !== n) throw new Error(`Jawaban AI tidak valid: ${raw}`);
  return valid;
}

/**
 * Baca isi gambar (screenshot slide/popup yang isinya bukan teks DOM, mis. surel di Praktikkan).
 * Model: AI_VISION_MODEL kalau ada, kalau nggak AI_MODEL (cx/gpt-6.1-sol terverifikasi bisa baca gambar).
 */
export async function describeImage(png: Buffer): Promise<string> {
  const res = await withRetry("jawab", () => client.chat.completions.create({
    model: process.env.AI_VISION_MODEL || process.env.AI_MODEL!,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Ini screenshot slide pelajaran. Tuliskan ulang semua teks informatif yang terlihat (mis. isi surel: " +
              "pengirim, penerima, CC, jabatan, perusahaan, isi pesan) apa adanya. Abaikan tombol/kontrol pemutar. " +
              "Tanpa komentar tambahan.",
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ],
      },
    ],
  }));
  return (res.choices[0]?.message?.content ?? "").trim();
}

/**
 * Soal menu tarik-turun (mis. urutan prioritas): tiap baris punya dropdown sendiri.
 * Return teks opsi yang dipilih per baris (urutan sama dengan `rows`).
 */
export async function pickDropdowns(
  question: string,
  rows: { label: string; options: string[] }[],
  context: string[] = [],
  avoid: string[][] = [],
): Promise<string[]> {
  const list = rows.map((r, i) => `${i + 1}. "${r.label}" → opsi: ${r.options.map((o) => `"${o}"`).join(", ")}`).join("\n");
  const res = await withRetry("jawab", () => client.chat.completions.create({
    model: process.env.AI_MODEL!,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Kamu menjawab soal materi keterampilan kerja (soft skills). " +
          'Balas HANYA JSON: {"jawaban":["opsi baris 1","opsi baris 2",...]} dengan teks opsi persis seperti tertulis.',
      },
      {
        role: "user",
        content:
          (context.length ? `Konteks/skenario dari slide sebelumnya:\n${context.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
          `Soal: ${question}\n\nTiap baris punya menu tarik-turun. Pilih satu opsi untuk tiap baris:\n${list}` +
          (avoid.length
            ? `\n\nJawaban berikut SUDAH DICOBA dan SALAH, jangan diulang: ${avoid.map((a) => `[${a.join(", ")}]`).join("; ")}`
            : ""),
      },
    ],
  }));
  const raw = res.choices[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  const ans: string[] = m ? (JSON.parse(m[0]).jawaban ?? []).map(String) : [];
  if (ans.length !== rows.length || ans.some((a, i) => !rows[i].options.includes(a))) {
    throw new Error(`Jawaban dropdown AI tidak valid: ${raw}`);
  }
  return ans;
}
