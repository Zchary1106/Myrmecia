import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChromeBinary, renderCards, CARD_WIDTH, CARD_HEIGHT } from '../src/tools/image-cards.js';

const chrome = findChromeBinary();
// Rendering needs a real Chromium; skip (rather than fail) on machines without one.
const describeIfChrome = chrome ? describe : describe.skip;

describe('image-cards spec handling', () => {
  it('rejects an empty card list', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'cards-empty-'));
    await expect(renderCards({ cards: [] }, outDir)).rejects.toThrow(/non-empty/);
  });
});

describeIfChrome('image-cards rendering', () => {
  it('renders one PNG per card at the Xiaohongshu 3:4 size', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'cards-render-'));
    const { paths } = await renderCards({
      theme: 'clean',
      cards: [
        { type: 'cover', tag: '测试', title: '标题**高亮**测试', subtitle: '副标题' },
        { type: 'point', index: '①', heading: '要点一', body: '正文说明', tip: '关键结论' },
        { type: 'list', heading: '清单页', items: ['第一项', '第二项'] },
        { type: 'end', heading: '结尾提问', body: '互动引导' },
      ],
    }, outDir, { timeoutMs: 60_000 });

    expect(paths).toHaveLength(4);
    for (const path of paths) {
      expect(existsSync(path)).toBe(true);
      const header = readFileSync(path).subarray(0, 24);
      // PNG magic number
      expect(header.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      // IHDR carries width/height as big-endian uint32 at offsets 16 and 20
      expect(header.readUInt32BE(16)).toBe(CARD_WIDTH);
      expect(header.readUInt32BE(20)).toBe(CARD_HEIGHT);
    }
  }, 120_000);

  it('escapes markup in model-authored copy so cards cannot be injected', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'cards-escape-'));
    await renderCards({
      cards: [{ type: 'cover', title: '<script>alert(1)</script>', subtitle: 'a & b' }],
    }, outDir, { timeoutMs: 60_000 });

    const html = readFileSync(join(outDir, 'card-01.html'), 'utf-8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  }, 120_000);

  it('caps list items so long lists cannot overflow the card', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'cards-cap-'));
    await renderCards({
      cards: [{ type: 'list', heading: '很多项', items: Array.from({ length: 12 }, (_, i) => `项目${i + 1}`) }],
    }, outDir, { timeoutMs: 60_000 });

    const html = readFileSync(join(outDir, 'card-01.html'), 'utf-8');
    expect((html.match(/<li>/g) || []).length).toBe(6);
    expect(html).not.toContain('项目7');
  }, 120_000);
});
