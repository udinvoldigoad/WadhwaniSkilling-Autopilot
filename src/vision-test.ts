/**
 * Tes kecil: apakah model di 9Router bisa membaca gambar?
 *
 *   npm run vision-test                 → pakai gambar buatan (teks rahasia acak), dicek otomatis
 *   npm run vision-test -- foto.png     → pakai gambar sendiri (mis. screenshot popup surel), lihat jawabannya
 *
 * Model: AI_VISION_MODEL kalau ada, kalau nggak AI_MODEL.
 * Gambar buatan dirender pakai Chromium headless biasa (BUKAN profil .profile, nggak buka situs apa pun).
 */
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { chromium } from "playwright";

const model = process.env.AI_VISION_MODEL || process.env.AI_MODEL!;
const client = new OpenAI({ baseURL: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY ?? "none" });

const file = process.argv[2];
let png: Buffer;
let secret = "";

if (file) {
  png = await readFile(file);
  console.log(`Gambar: ${file} (${Math.round(png.length / 1024)} KB)`);
} else {
  secret = `KODE-${Math.floor(1000 + Math.random() * 9000)}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 700, height: 260 } });
  await page.setContent(`
    <body style="margin:0;font:20px sans-serif;background:#fff;padding:24px">
      <div style="border:2px solid #333;padding:16px">
        Kepada: Abdul@jlk.com<br>CC: Om@jlk.com, Monica@kc.com<br>
        Judul: Keterlambatan pengiriman<br><br>
        Kode verifikasi: <b>${secret}</b>
      </div>
    </body>`);
  png = await page.screenshot();
  await browser.close();
  console.log(`Gambar buatan berisi teks rahasia (nggak ditulis di prompt): ${secret}`);
}

console.log(`Model: ${model}\nKirim ke ${process.env.AI_BASE_URL} ...`);
const t0 = Date.now();
try {
  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: file
              ? "Tuliskan ulang semua teks yang terlihat di gambar ini, apa adanya."
              : "Tuliskan ulang semua teks di gambar ini, termasuk kode verifikasinya.",
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ],
      },
    ],
  });
  const out = res.choices[0]?.message?.content ?? "";
  console.log(`\n--- Jawaban model (${((Date.now() - t0) / 1000).toFixed(1)} dtk) ---\n${out}\n---`);
  if (secret) {
    console.log(
      out.includes(secret)
        ? `\n✅ BISA baca gambar (kode ${secret} disebut dengan benar)`
        : `\n❌ Kode ${secret} nggak disebut → kemungkinan model nggak baca gambar (atau mengarang). Cek jawabannya di atas.`,
    );
  }
} catch (e: any) {
  console.log(`\n❌ Request gagal: ${e?.status ?? ""} ${e?.message ?? e}`);
  console.log("Kemungkinan model/endpoint nggak menerima input gambar. Coba model lain lewat AI_VISION_MODEL di .env.");
}
