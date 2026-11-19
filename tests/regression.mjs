import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAssessment } from '../src/quiz.ts';
import { runCollaboration } from '../src/collaboration.ts';
import { refreshAndOpenPost } from '../src/post.ts';
import { nextModule } from '../src/modules.ts';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function fixture(t, html) {
  const ctx = await browser.newContext();
  t.after(() => ctx.close());
  await ctx.route('**/*', r => r.fulfill({contentType:'text/html',body:html(new URL(r.request().url()).pathname)}));
  return ctx.newPage();
}
test('resume dari 6 memeriksa radio sungguhan dari soal 1', async t => {
  const p = await fixture(t, path => {
    const n = Number(path.slice(1));
    return '<h1>Modul Penilaian</h1>' + (!n ? '<a href=/6>Lanjutkan pengerjaan kuis yang terakhir</a>' : n === 3 ? '<button>Finish review</button>' : `<a href=/1>1</a><div class=que><span class=qno>${n}</span><p class=qtext>Contoh ${n}?</p><input type=radio name=a value=-1 checked hidden><label><input type=radio name=a>AA</label><label><input type=radio name=a id=b>BB</label></div><button onclick="if(b.checked) location.href='/${n+1}'">Halaman selanjutnya</button>`);
  });
  await p.goto('https://fixture.test/');
  const prompts = [];
  assert.equal(await runAssessment(p, async (_a,_n,_v,c) => { prompts.push(...c); return [2]; }), true);
  assert.deepEqual(prompts,['Contoh 1?','Contoh 2?']);
});
test('pilih konsep, jawab pertanyaan (4 mark), kirim, lihat hasil', async t => {
  const p = await fixture(t, () => `<main><span>Keluar dari latihan</span><section><p>Pilih satu konsep yang Anda gunakan</p><div><button onclick="box.hidden=false">Memahami konflik</button><button>Tenang</button></div></section><div id=box hidden><p>Bagaimana caranya? (4 mark)</p><textarea></textarea><button onclick="if(document.querySelector('textarea').value==='Draf')document.querySelector('main').innerHTML='<p>Skor Anda</p><p>Klik panah kanan di bawah untuk melanjutkan</p>'">Kirim</button></div></main>`);
  await p.goto('https://fixture.test/');
  let prompt;
  assert.equal(await runCollaboration(p,'Berkolaborasi',async q => { prompt=q; return 'Draf'; }),true);
  assert.match(prompt,/Memahami konflik[\s\S]*4 mark/);
});
test('refleksi berupa perintah tanpa tanda tanya tetap dijawab', async t => {
  const p = await fixture(t, () => `<main><span>Keluar dari latihan</span><p>Jelaskan bagaimana Anda sebagai <strong>Desainer</strong> mengembangkan solusi inovatif.</p><textarea></textarea><button onclick="if(document.querySelector('textarea').value==='Draf')document.querySelector('main').innerHTML='<p>Skor Anda</p><p>Klik panah kanan di bawah untuk melanjutkan</p>'">Kirim</button></main>`);
  await p.goto('https://fixture.test/');
  assert.equal(await runCollaboration(p,'Berkolaborasi',async q => { assert.match(q,/Desainer/); return 'Draf'; }),true);
});
test('pertanyaan lanjutan Bagaimana dengan titik dibaca setelah jawaban pertama', async t => {
  const p = await fixture(t, () => `<main><span>Keluar dari latihan</span><section id=history><p>Jelaskan bagaimana Anda sebagai Desainer mengembangkan solusi inovatif.</p></section><textarea></textarea><button>Kirim</button></main>`);
  await p.goto('https://fixture.test/');
  await p.evaluate(() => {
    let sent = 0;
    document.querySelector('button').onclick = () => {
      const box = document.querySelector('textarea');
      if (!box.value) return;
      if (++sent === 1) {
        document.querySelector('section').insertAdjacentHTML('beforeend','<p>Sebagai Desainer, saya membuat prototipe.</p><p>Bagaimana pemikiran desain yang Anda terapkan dalam aktivitas ini terkait dengan konsep pemikiran desain yang dipelajari dalam pelajaran.</p>');
        box.value = '';
      } else document.querySelector('main').innerHTML = '<p>Skor Anda</p><p>Klik panah kanan di bawah untuk melanjutkan</p>';
    };
  });
  const prompts = [];
  assert.equal(await runCollaboration(p,'Berkolaborasi', async q => { prompts.push(q); return 'Draf '+prompts.length; }), true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /^Bagaimana.*pelajaran\.$/);
});
test('centang baru setelah tepat satu refresh lalu buka Pasca kelas', async t => {
  let loads=0;
  const p = await fixture(t, () => `<button class=accordion-trigger>Di kelas ${loads++ ? '1':'0'}/1 Selesai</button><button class=accordion-trigger aria-expanded=false onclick="this.setAttribute('aria-expanded','true')">Pasca kelas</button>`);
  await p.goto('https://fixture.test/');
  assert.equal(await refreshAndOpenPost(p,'Berkolaborasi'),true);
  assert.equal(loads,2);
  assert.equal(await p.getByText('Pasca kelas').getAttribute('aria-expanded'),'true');
});
for (const done of [false,true]) test(`fallback daftar kursus: modul saat ini selesai=${done}`, async t => {
  const base='https://skilling.wadhwanifoundation.org/id/courses/test';
  const p = await fixture(t, path => path.endsWith('/test') ? `<button class=accordion-trigger>Modul A\n${done?1:0}/1 Pelajaran Telah Diselesaikan</button><button class=accordion-trigger aria-controls=b aria-expanded=false onclick="b.hidden=false">Modul B\n0/1 Pelajaran Telah Diselesaikan</button><div id=b hidden><a href="${base}/course-lesson/2/20">Pelajaran B</a></div>` : '<h2>Modul A</h2>');
  await p.goto(base+'/course-lesson/1/10');
  assert.equal(await nextModule(p),done);
  assert.equal(p.url(),base+(done?'/course-lesson/2/20':'/course-lesson/1/10'));
});
