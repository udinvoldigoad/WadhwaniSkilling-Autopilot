// Panel kontrol lokal: http://127.0.0.1:4317 (dibuka lewat "Mulai Bot.bat").
// Menjalankan bot (src/index.ts) sebagai proses anak, meneruskan log ke browser lewat SSE.
// Hanya dengar di 127.0.0.1; POST wajib header X-Panel (request lintas situs nggak bisa ngirim itu tanpa preflight).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { openBrowser } from "./browser.js";

const PORT = Number(process.env.PANEL_PORT ?? 4317);
const URL_ = `http://127.0.0.1:${PORT}`;
// Chrome bot dibuka panel dengan port debug lokal → bot (proses anak) nyambung lewat CDP
const CDP_PORT = Number(process.env.PANEL_CDP_PORT ?? 9333);
const PANEL_W = 300, PANEL_H = 400;
const ROOT = process.cwd();
const PREFS = path.join(ROOT, "logs", "panel.json");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

type Bot = { proc: ChildProcess; startedAt: number; mode: string; max: number };
let bot: Bot | null = null;
let lines: string[] = []; // log run ini (maks 500)
let waitingInput = false; // bot lagi nunggu Enter (readline)
let exitInfo: { code: number | null; at: number } | null = null;
const clients = new Set<ServerResponse>();

const readJson = (f: string) => {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
};

function state() {
  const cp = readJson(path.join(ROOT, "logs", "checkpoint.json"));
  const prefs = readJson(PREFS) ?? {};
  return {
    running: !!bot,
    startedAt: bot?.startedAt ?? null,
    mode: bot?.mode ?? null,
    waitingInput,
    exit: exitInfo,
    checkpoint: cp?.url
      ? { url: cp.url, lesson: String(cp.url).split("/course-lesson/")[1] ?? cp.url, step: cp.step ?? "", time: cp.time ?? null }
      : null,
    max: prefs.max ?? 4,
  };
}

function broadcast(ev: string, data: unknown) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

function pushLine(line: string) {
  lines.push(line);
  if (lines.length > 500) lines = lines.slice(-500);
  broadcast("line", line);
}

// Prompt readline ("…lalu Enter...") ditulis tanpa newline → cek juga potongan baris yang belum selesai
const PROMPT = /(lalu |tekan )Enter|Enter setelah/i;

function startBot(mode: "resume" | "choose", max: number) {
  if (bot) return "Bot sudah jalan";
  if (!existsSync(TSX)) return "node_modules belum ada → jalankan npm i dulu";
  if (!existsSync(path.join(ROOT, ".env"))) return ".env belum ada (salin dari .env.example)";
  try {
    mkdirSync(path.dirname(PREFS), { recursive: true });
    writeFileSync(PREFS, JSON.stringify({ max }));
  } catch {
    return "Pengaturan panel tidak bisa disimpan. Pastikan folder logs di dalam proyek dapat ditulis.";
  }

  if (!ctx) return "Chrome bot belum siap";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MAX_PELAJARAN: String(max),
    FORCE_COLOR: "0",
    BOT_CDP: `http://127.0.0.1:${CDP_PORT}`,
    PANEL_URL: URL_,
  };
  // Variabel sisa dari terminal jangan ikut (dulu START_URL lama bikin bot selalu buka 148)
  delete env.START_URL;
  delete env.REDO;
  if (mode === "choose") env.RESUME = "0";
  else delete env.RESUME;

  lines = [];
  exitInfo = null;
  waitingInput = false;
  const proc = spawn(process.execPath, [TSX, "--env-file=.env", "src/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  bot = { proc, startedAt: Date.now(), mode, max };
  pushLine(`[panel] Bot dimulai (${mode === "resume" ? "lanjut dari posisi terakhir" : "pilih pelajaran sendiri"}, maks ${max} pelajaran)`);

  const reader = (stream: NodeJS.ReadableStream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk.replace(/\r/g, "");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) {
        if (waitingInput) { waitingInput = false; broadcast("state", state()); }
        pushLine(p);
      }
      if (PROMPT.test(buf)) {
        pushLine(buf.trim());
        buf = "";
        waitingInput = true;
        broadcast("state", state());
      }
    });
  };
  reader(proc.stdout!);
  reader(proc.stderr!);
  proc.on("exit", (code) => {
    pushLine(`[panel] Bot berhenti (kode ${code ?? "?"})`);
    bot = null;
    waitingInput = false;
    exitInfo = { code, at: Date.now() };
    broadcast("state", state());
  });
  broadcast("state", state());
  return null;
}

function stopBot() {
  if (!bot) return;
  const pid = bot.proc.pid;
  pushLine("[panel] Menghentikan bot…");
  // /T = ikut proses anak node; Chrome bot milik panel, jadi tetap terbuka
  if (process.platform === "win32" && pid) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else bot.proc.kill();
}

function sendEnter() {
  if (!bot || !waitingInput) return;
  waitingInput = false;
  pushLine("[panel] Enter dikirim");
  bot.proc.stdin!.write("\n");
  broadcast("state", state());
}

const body = (req: IncomingMessage) =>
  new Promise<any>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
  });

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return json(res, 403, { error: "host" });
  const url = new URL(req.url ?? "/", URL_);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(readFileSync(path.join(ROOT, "panel", "index.html")));
  }
  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    res.write(`event: history\ndata: ${JSON.stringify(lines)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  // Screenshot diagnosa (cuma file .png di logs/)
  if (req.method === "GET" && url.pathname === "/shot") {
    const f = path.resolve(ROOT, url.searchParams.get("f") ?? "");
    if (!f.startsWith(path.join(ROOT, "logs") + path.sep) || !f.endsWith(".png") || !existsSync(f)) return json(res, 404, {});
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(readFileSync(f));
  }

  if (req.method === "POST") {
    if (req.headers["x-panel"] !== "1") return json(res, 403, { error: "header" });
    const b = await body(req);
    if (url.pathname === "/api/start") {
      const max = Math.min(50, Math.max(1, Math.round(Number(b.max) || 4)));
      const err = startBot(b.mode === "choose" ? "choose" : "resume", max);
      return json(res, err ? 409 : 200, { error: err });
    }
    if (url.pathname === "/api/stop") { stopBot(); return json(res, 200, {}); }
    if (url.pathname === "/api/enter") { sendEnter(); return json(res, 200, {}); }
  }
  json(res, 404, {});
});

// ── Chrome bot + jendela panel kecil ─────────────────────────────────────────
let ctx: BrowserContext | null = null;
let mainPage: Page | null = null;
let panelPage: Page | null = null;

// Jendela panel selalu di atas (Chrome nggak punya opsi ini) → SetWindowPos HWND_TOPMOST lewat PowerShell.
// Dicocokkan dari judul jendela "Panel Bot…" (judul jendela terminal sengaja beda).
const TOPMOST_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class PanelWin {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  public static int Top(string t) {
    int n = 0;
    EnumWindows((h, l) => {
      var s = new StringBuilder(256); GetWindowText(h, s, 256);
      if (IsWindowVisible(h) && s.ToString().StartsWith(t)) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x13); n++; }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
"@
[PanelWin]::Top("Panel Bot")`;

function makeTopmost() {
  if (process.platform !== "win32") return;
  const enc = Buffer.from(TOPMOST_PS, "utf16le").toString("base64");
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { windowsHide: true });
  let out = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.on("exit", () => { if (/(^|\n)0\s*$/.test(out.trim())) console.log("Jendela panel nggak bisa dibuat selalu-di-atas (judul nggak ketemu)"); });
}

async function openPanelWindow() {
  if (!ctx || !mainPage || (panelPage && !panelPage.isClosed())) return;
  // Popup dari halaman bot = jendela Chrome terpisah (bukan tab), ukurannya diatur lewat CDP
  const [popup] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 10_000 }),
    mainPage.evaluate(`window.open(${JSON.stringify(URL_)}, "panelbot", "popup,width=${PANEL_W},height=${PANEL_H}")`),
  ]);
  panelPage = popup;
  try {
    const scr: any = await mainPage.evaluate("({w: screen.availWidth, h: screen.availHeight, l: screen.availLeft || 0, t: screen.availTop || 0})");
    const cdp = await ctx.newCDPSession(popup);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as any;
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: scr.l + scr.w - PANEL_W - 8, top: scr.t + scr.h - PANEL_H - 8, width: PANEL_W, height: PANEL_H },
    });
    await cdp.detach();
  } catch (e) {
    console.log(`Posisi jendela panel nggak bisa diatur: ${e}`);
  }
  await popup.waitForLoadState().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  makeTopmost();
  popup.on("close", () => {
    panelPage = null;
    console.log("Jendela panel ditutup → tekan Enter di sini untuk membukanya lagi");
  });
}

async function launchChrome() {
  const b = await openBrowser([`--remote-debugging-port=${CDP_PORT}`]);
  ctx = b.ctx;
  mainPage = b.page;
  ctx.on("close", () => {
    console.log("Chrome bot ditutup → panel berhenti");
    shutdown();
  });
  await mainPage.goto("https://skilling.wadhwanifoundation.org/id/home").catch(() => {});
  await openPanelWindow().catch((e) => console.log(`Jendela panel gagal dibuka: ${e}`));
}

server.on("error", (e: any) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Panel sudah jalan (port ${PORT} dipakai). Tutup jendela "Bot Wadhwani" yang lama dulu.`);
    setTimeout(() => process.exit(1), 500);
  } else throw e;
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Panel bot: ${URL_}`);
  console.log("Jangan tutup jendela ini (menutupnya = bot & panel berhenti). Enter = buka lagi jendela panel.");
  if (process.env.PANEL_NO_CHROME !== "1") await launchChrome();
  process.stdin.on("data", () => { openPanelWindow().catch(() => {}); });
});

function shutdown() { stopBot(); setTimeout(() => process.exit(0), 300); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
