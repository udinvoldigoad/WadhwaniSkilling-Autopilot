import { appendFileSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";

// Panel nanti tinggal subscribe ke `bus.on("log", ...)`.
export const bus = new EventEmitter();

// Tiap run → file baru logs/run-YYYY-MM-DD_HH-MM-SS.log (waktu lokal), jadi nggak perlu salin dari terminal.
const pad = (n: number) => String(n).padStart(2, "0");
const d = new Date();
const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
export const LOG_FILE = path.join("logs", `run-${stamp}.log`);

let fileOk = true;
try {
  mkdirSync("logs", { recursive: true });
} catch {
  fileOk = false;
}

function toFile(line: string) {
  if (!fileOk) return;
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    fileOk = false; // gagal nulis (disk/izin) → tetap jalan, cuma ke terminal
  }
}

export function log(msg: string) {
  const line = `[${new Date().toLocaleTimeString("id-ID")}] ${msg}`;
  console.log(line);
  toFile(line);
  bus.emit("log", line);
}

// Error yang bikin bot crash juga masuk file (biasanya cuma kelihatan di terminal)
const crash = (kind: string) => (e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  toFile(`[${new Date().toLocaleTimeString("id-ID")}] ✖ ${kind}: ${msg}`);
  console.error(e);
  process.exit(1);
};
process.on("uncaughtException", crash("uncaughtException"));
process.on("unhandledRejection", crash("unhandledRejection"));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
