import { chromium } from "playwright";

export const LAUNCH_ARGS = ["--start-maximized", "--autoplay-policy=no-user-gesture-required"];

// Profil terpisah di ./.profile -> login sekali manual, setelah itu kesimpan.
export async function openBrowser(extraArgs: string[] = []) {
  // Dijalankan dari panel: Chrome bot sudah dibuka panel → sambung ke situ, jangan buka Chrome baru
  if (process.env.BOT_CDP) {
    const browser = await chromium.connectOverCDP(process.env.BOT_CDP);
    const ctx = browser.contexts()[0];
    const panel = process.env.PANEL_URL ?? "http://127.0.0.1:";
    const page = ctx.pages().find((p) => !p.url().startsWith(panel)) ?? (await ctx.newPage());
    return { ctx, page };
  }
  try {
    const ctx = await chromium.launchPersistentContext(".profile", {
      headless: false,
      viewport: null,
      args: [...LAUNCH_ARGS, ...extraArgs],
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return { ctx, page };
  } catch (e) {
    // Jendela Chrome bot dari run sebelumnya masih kebuka → profil terkunci
    if (/existing browser session|profile is already in use/i.test(String(e))) {
      console.error("✖ Profil .profile masih dipakai jendela Chrome bot lain. Tutup jendela itu dulu, lalu jalankan ulang.");
      process.exit(1);
    }
    throw e;
  }
}
