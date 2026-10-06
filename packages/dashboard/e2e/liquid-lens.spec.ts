import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';

test('backdrop refraction changes real pixels and light responds to the pointer', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('myrmecia.theme', 'light'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const toolbar = page.locator('[data-app-toolbar]');
  await expect(toolbar).toHaveAttribute('data-liquid-lens', 'svg');
  await expect(toolbar).toHaveCSS('backdrop-filter', /url\(.+\).*blur/);
  // A high-contrast backdrop is a controlled optical probe, not production UI.
  await page.addStyleTag({ content: `
    .app-glass-shell { background: repeating-linear-gradient(45deg, #789ab7 0 7px, #e7edf5 7px 14px); }
    .app-glass-shell::before { display: none; }
  ` });
  await page.mouse.move(20, 890);
  const box = (await toolbar.boundingBox())!;
  await expect(toolbar.locator('feImage')).toHaveAttribute('href', /^data:image\/png/);
  const refracted = await page.screenshot({ clip: box, animations: 'disabled' });
  const filter = await toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--liquid-filter'));
  await toolbar.evaluate(element => (element as HTMLElement).style.setProperty('--liquid-filter', 'blur(0px)'));
  await expect(toolbar).toHaveCSS('backdrop-filter', /blur\(0px\)/);
  const frosted = await page.screenshot({ clip: box, animations: 'disabled' });
  await toolbar.evaluate((element, value) => (element as HTMLElement).style.setProperty('--liquid-filter', value), filter);
  // Reuse the workspace's image decoder; no new production dependency.
  const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp');
  const a = await sharp(refracted).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(frosted).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const difference = (firstRow: number, lastRow: number) => {
    let sum = 0, pixels = 0;
    for (let y = firstRow; y < lastRow; y++) {
      for (let x = 80; x < a.info.width - 80; x++) {
        const i = (y * a.info.width + x) * 3;
        sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
        pixels++;
      }
    }
    return sum / (pixels * 3);
  };
  const meanDifference = difference(3, 16);
  const centerDifference = difference(Math.floor(a.info.height / 2) - 5, Math.floor(a.info.height / 2) + 5);
  expect(meanDifference, 'SVG must measurably refract the backdrop, not just set a CSS URL').toBeGreaterThan(5);
  expect(meanDifference, 'The bevel must bend more strongly than the flat optical center').toBeGreaterThan(centerDifference * 1.25);
  console.log('Optical verification:', { meanEdgeChannelDifference: meanDifference, centerDifference });
  await testInfo.attach('optical-measurement', { body: JSON.stringify({ meanEdgeChannelDifference: meanDifference, centerDifference }), contentType: 'application/json' });
  await sharp({ create: { width: a.info.width, height: a.info.height * 2 + 12, channels: 3, background: '#e7edf5' } })
    .composite([{ input: refracted, top: 0, left: 0 }, { input: frosted, top: a.info.height + 12, left: 0 }])
    .png().toFile(testInfo.outputPath('refraction-on-and-off.png'));

  await page.mouse.move(box.x + 70, box.y + 20);
  await expect.poll(() => toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'))).not.toBe('');
  const first = await toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'));
  await page.mouse.move(box.x + 250, box.y + 28);
  await expect.poll(() => toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'))).not.toBe(first);
  await page.screenshot({ path: testInfo.outputPath('liquid-optics-probe.png'), animations: 'disabled' });
});

test('one lens slides to the selected navigation item and remains click-through', async ({ page }) => {
  await page.goto('/');
  const indicator = page.locator('[data-liquid-nav-indicator]');
  await expect(indicator).toBeVisible();
  const initial = (await indicator.boundingBox())!;
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const button = page.getByRole('button', { name: 'Tools', exact: true });
  await expect(button).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => {
    const a = await indicator.boundingBox(), b = await button.boundingBox();
    return a && b ? Math.abs(a.y - b.y) : Infinity;
  }).toBeLessThan(2);
  expect((await indicator.boundingBox())!.y).not.toBe(initial.y);
  await expect(indicator).toHaveCSS('pointer-events', 'none');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByLabel('Describe work for your Agent Team')).toBeVisible();
});

test('increased contrast disables refraction and prevents dynamic glare', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await page.goto('/');
  const toolbar = page.locator('[data-app-toolbar]');
  await expect(toolbar).toHaveAttribute('data-liquid-lens', 'frosted');
  await expect(toolbar).toHaveCSS('backdrop-filter', 'none');
  await expect(page.locator('[data-liquid-nav-indicator]')).toHaveCSS('transition-property', 'none');
});

test('an engine outside the verified SVG path keeps the functional frosted fallback', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 Version/18.0 Safari/605.1.15' }));
  await page.goto('/');
  await expect(page.locator('[data-app-toolbar]')).toHaveAttribute('data-liquid-lens', 'frosted');
  await expect(page.locator('[data-app-toolbar]')).toHaveCSS('backdrop-filter', 'blur(22px) saturate(1.35)');
  await page.getByLabel('Describe work for your Agent Team').fill('Fallback draft');
  await expect(page.getByLabel('Describe work for your Agent Team')).toHaveValue('Fallback draft');
});

test('resize and live accessibility changes preserve the draft and rebuild the lens', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const toolbar = page.locator('[data-app-toolbar]');
  const input = page.getByLabel('Describe work for your Agent Team');
  await input.fill('Keep this draft through optical changes.');
  await expect(toolbar).toHaveAttribute('data-liquid-lens', 'svg');
  const initialWidth = await toolbar.locator('feImage').getAttribute('width');
  const box = (await toolbar.boundingBox())!;
  await page.mouse.move(box.x + 70, box.y + 20);
  await expect.poll(() => toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'))).not.toBe('');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'))).toBe('');
  await page.mouse.move(box.x + 250, box.y + 28);
  expect(await toolbar.evaluate(element => (element as HTMLElement).style.getPropertyValue('--lens-x'))).toBe('');
  await page.emulateMedia({ contrast: 'more' });
  await expect(toolbar).toHaveAttribute('data-liquid-lens', 'frosted');
  await expect(toolbar).toHaveCSS('backdrop-filter', 'none');
  await page.setViewportSize({ width: 760, height: 900 });
  await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'no-preference' });
  await expect(toolbar).toHaveAttribute('data-liquid-lens', 'svg');
  await expect.poll(() => toolbar.locator('feImage').getAttribute('width')).not.toBe(initialWidth);
  await expect.poll(async () => Number(await toolbar.locator('feImage').getAttribute('width')) === Math.round((await toolbar.boundingBox())!.width)).toBe(true);
  await expect(input).toHaveValue('Keep this draft through optical changes.');
});
