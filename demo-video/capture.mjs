/**
 * Capture key Myrmecia dashboard pages as screenshots for the demo video.
 *
 * Assumes the seeded demo is already running:
 *   - API server on http://localhost:3000 (DB_PATH=demo seed)
 *   - Dashboard on http://localhost:5173
 *
 * The dashboard navigates via sidebar buttons that set an in-memory view, so we
 * click each nav item by its label text rather than visiting a URL.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shots = JSON.parse(readFileSync(join(__dirname, 'shots.json'), 'utf-8'));
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';
const FRAMES_DIR = join(__dirname, 'public', 'frames');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    // Bypass any system-level HTTP proxy so localhost loads directly.
    args: ['--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  console.log(`[capture] opening ${DASHBOARD_URL}`);
  await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Let the SPA mount + initial data loaders settle.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await sleep(2500);

  for (const shot of shots) {
    try {
      const nav = page.getByText(shot.nav, { exact: true }).first();
      await nav.click({ timeout: 10_000 });
    } catch (err) {
      console.warn(`[capture] could not click "${shot.nav}": ${err.message}`);
    }
    // Give the view + its data a moment to render.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(1800);
    const out = join(FRAMES_DIR, `${shot.id}.png`);
    await page.screenshot({ path: out });
    console.log(`[capture] ${shot.id} -> ${out}`);
  }

  await browser.close();
  console.log('[capture] done');
}

main().catch((err) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
