/**
 * Render the Myrmecia demo composition to mp4.
 *
 * This environment has a system proxy (Clash) that intercepts loopback, so we
 * strip proxy env vars before launching the renderer's browser (it loads the
 * bundle from 127.0.0.1) and reuse the already-installed Playwright Chrome to
 * avoid Remotion's external chrome download going through the proxy.
 */
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']) {
  delete process.env[key];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const entryPoint = join(__dirname, 'src', 'index.ts');
const outputLocation = join(__dirname, 'out', 'myrmecia-demo.mp4');
mkdirSync(join(__dirname, 'out'), { recursive: true });

// Reuse the full Playwright Chrome for Testing so Remotion doesn't download one.
const browserExecutable = chromium.executablePath().includes('chrome-mac')
  ? chromium.executablePath()
  : chromium.executablePath().replace(/chromium_headless_shell-(\d+)\/.*/, 'chromium-$1/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

async function main() {
  console.log('[render] bundling...');
  const serveUrl = await bundle({ entryPoint });

  console.log('[render] selecting composition...');
  const composition = await selectComposition({ serveUrl, id: 'Demo', browserExecutable });

  console.log(`[render] rendering ${composition.durationInFrames} frames -> ${outputLocation}`);
  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    imageFormat: 'jpeg',
    outputLocation,
    browserExecutable,
    concurrency: 2,
    onProgress: ({ progress }) => {
      process.stdout.write(`\r[render] ${(progress * 100).toFixed(0)}%   `);
    },
  });
  process.stdout.write('\n');
  console.log('[render] done:', outputLocation);
}

main().catch((err) => {
  console.error('[render] failed:', err);
  process.exit(1);
});
