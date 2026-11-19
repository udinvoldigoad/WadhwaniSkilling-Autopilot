# Wadhwani Autopilot

Alat bantu lokal untuk mengoperasikan Wadhwani Skilling melalui browser. Panel **Asisten Belajar** menampilkan aktivitas yang sedang berjalan, posisi terakhir, dan kapan pengguna perlu mengambil alih. Bot menggunakan Playwright untuk berinteraksi dengan halaman dan 9Router untuk meminta jawaban dari model AI.

> **Sebelum menjalankan:** bot dapat memilih dan **mengirim jawaban atas nama akun yang sedang login**, termasuk pada kuis dengan percobaan terbatas. Untuk mencoba alurnya tanpa menggunakan akun atau percobaan kuis, jalankan `npm test` setelah instalasi.

## Instalasi pertama (Windows)

Siapkan Node.js 22 LTS atau lebih baru, npm, dan layanan 9Router yang sudah berjalan. Buka PowerShell di folder proyek, lalu jalankan:

```powershell
npm ci
npx playwright install chromium
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Buka `.env` di editor teks. Isi `AI_BASE_URL` dengan alamat endpoint 9Router (contoh: `http://localhost:20128/v1`), `AI_API_KEY` dengan kunci milikmu, dan `AI_MODEL` dengan nama model yang tersedia di router. `AI_VISION_MODEL` bersifat opsional jika memakai model berbeda untuk membaca gambar.

## Menjalankan sesi

1. Klik dua kali **`Mulai Bot.bat`**. Jendela kursus dan panel lokal **Asisten Belajar** akan terbuka. Alamat bawaan panel adalah `http://127.0.0.1:4317`.
2. Untuk percobaan pertama, atur **Berhenti setelah** menjadi **1 pelajaran**, lalu klik **Pilih pelajaran**. Login sendiri di jendela kursus, buka satu pelajaran hingga isinya terlihat, lalu klik **Sudah, lanjutkan** saat diminta.
3. Pantau status di panel. **Menunggu jawaban AI** berarti belum perlu bertindak. Jika muncul **Giliran kamu**, baca petunjuk dan periksa halaman kursus sebelum melanjutkan. Pilih **Hentikan sesi** jika ingin mengambil alih; jawaban yang sudah dikirim tetap tercatat.
4. Untuk sesi berikutnya, pilih **Lanjutkan sesi** agar bot membuka posisi terakhir dan memeriksa ulang progres di halaman. Buka **Rincian sesi** untuk melihat aktivitas yang terkonfirmasi, masih menunggu centang, atau perlu bantuan.

**Lewat terminal:** jalankan `npm start` sebagai alternatif panel. Ikuti petunjuk terminal dan tekan Enter jika diminta. Untuk menentukan batas sesi terminal, atur `MAX_PELAJARAN` di `.env`. Untuk memilih pelajaran secara manual meskipun ada posisi tersimpan, kosongkan `START_URL` dan gunakan `RESUME=0`.

## Risiko penggunaan

- **Pembatalan sertifikat Wadhwani Skilling.** Jika penggunaan bot atau AI melanggar aturan program, penyelenggara dapat menolak penerbitan sertifikat atau mencabut sertifikat yang sudah terbit. Periksa ketentuan sertifikasi program sebelum menggunakan bot untuk aktivitas yang dinilai.
- **Akun dan penilaian.** Gunakan hanya pada akun dan aktivitas yang memang mengizinkan otomasi serta penggunaan AI. Periksa aturan penyelenggara, khususnya untuk penilaian, refleksi pribadi, dan sertifikasi. Lisensi kode tidak memberikan izin untuk mengotomasi layanan pihak ketiga.
- **Jawaban dan progres.** AI dapat salah memahami soal atau mengirim umpan balik yang tidak mewakili pendapatmu. Perubahan tampilan kursus juga bisa membuat bot salah memilih atau berhenti. Periksa nilai dan tanda selesai di situs; pesan *jawaban terkirim* belum berarti *progres terkonfirmasi*.
- **Privasi dan biaya.** Teks soal, pilihan jawaban, dan pada aktivitas tertentu gambar slide dapat dikirim melalui 9Router ke penyedia model yang dikonfigurasi. Router lokal tidak selalu berarti pemrosesan lokal. Periksa kebijakan penyedia dan biaya API sebelum memulai.
- **Data di komputer.** `.env` berisi kunci API, `.profile/` menyimpan sesi login, dan `logs/` dapat berisi URL pelajaran, jawaban, serta tangkapan layar. Jangan unggah folder atau file tersebut. Jika melaporkan masalah, bagikan hanya potongan log yang diperlukan setelah menyamarkan data pribadi.

## Kontribusi dan lisensi

Untuk mengusulkan perbaikan, jelaskan masalah dan langkah reproduksinya. Untuk perubahan alur, tambahkan tes dengan halaman simulasi di `tests/`, lalu jalankan `npm run typecheck` dan `npm test` sebelum mengajukan *pull request*. Jangan sertakan kredensial atau salinan materi kursus. Pertahankan interaksi melalui UI; jangan memalsukan nilai atau status selesai.

Kode proyek tersedia dengan **[Lisensi MIT](LICENSE)**. Kamu boleh menggunakan, memodifikasi, dan mendistribusikan kode dengan menyertakan pemberitahuan hak cipta dan lisensinya. Kontribusi yang diajukan untuk digabungkan ke proyek menggunakan lisensi yang sama. Lisensi ini tidak mencakup materi kursus, merek Wadhwani, atau dependensi pihak ketiga. Perangkat lunak disediakan tanpa jaminan.
