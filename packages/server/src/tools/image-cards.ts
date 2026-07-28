/**
 * Xiaohongshu-style image card renderer.
 *
 * Turns a structured card spec into real PNG files (1080x1440, the 3:4 ratio
 * Xiaohongshu expects) by laying the cards out in HTML/CSS and screenshotting
 * them with a headless Chromium.
 *
 * Why PNG and not the existing `image.generate_svg`: social platforms reject
 * SVG uploads (it can carry script), and the note publish tools
 * (`mcp__xiaohongshu__publish_content`) need real raster files on disk. Going
 * through a browser also gives us proper CJK text shaping and line breaking,
 * which is the hard part of generating Chinese content cards.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const execFileAsync = promisify(execFile);

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

export interface CardSpec {
  /** cover = 封面页, point = 编号要点页, list = 清单页, end = 结尾互动页 */
  type?: 'cover' | 'point' | 'list' | 'end';
  tag?: string;
  title?: string;
  subtitle?: string;
  index?: string;
  heading?: string;
  body?: string;
  tip?: string;
  items?: string[];
}

export interface CardRenderSpec {
  cards: CardSpec[];
  theme?: 'warm' | 'clean' | 'dark';
}

const THEMES = {
  warm: { bg: 'linear-gradient(160deg,#FFF8F0 0%,#FFE8E0 100%)', accent: '#FF2E4D', text: '#1a1a1a', muted: '#555', card: 'rgba(255,255,255,.72)' },
  clean: { bg: 'linear-gradient(160deg,#F5F9FF 0%,#E8F0FE 100%)', accent: '#2563eb', text: '#111827', muted: '#4b5563', card: 'rgba(255,255,255,.8)' },
  dark: { bg: 'linear-gradient(160deg,#1f2430 0%,#11141c 100%)', accent: '#FF6B81', text: '#f8fafc', muted: '#c3c9d5', card: 'rgba(255,255,255,.08)' },
} as const;

const FONT_STACK = `"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","Heiti SC",sans-serif`;

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Let authors mark an emphasis span with **…**; everything else is escaped, so
 * model-authored copy can never inject markup into the card template.
 */
function inlineEmphasis(value: string): string {
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<span class="hl">$1</span>');
}

/** Candidate Chromium/Chrome binaries, in preference order. */
function chromeCandidates(): string[] {
  const fromEnv = [process.env.CHROME_BIN, process.env.PUPPETEER_EXECUTABLE_PATH, process.env.PLAYWRIGHT_CHROMIUM_PATH]
    .filter((value): value is string => !!value);

  const staticPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];

  // Browsers already downloaded by sibling tooling on this machine.
  const cached: string[] = [];
  const cacheRoots = [
    { dir: join(homedir(), 'Library/Caches/xiaohongshu-mcp/browser'), rel: ['Chromium.app/Contents/MacOS/Chromium'] },
    { dir: join(homedir(), 'Library/Caches/ms-playwright'), rel: ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome'] },
    { dir: join(homedir(), '.cache/puppeteer/chrome'), rel: ['chrome-linux64/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'] },
    { dir: join(homedir(), '.cache/ms-playwright'), rel: ['chrome-linux/chrome'] },
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root.dir)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(root.dir); } catch { continue; }
    for (const entry of entries.sort().reverse()) {
      for (const rel of root.rel) cached.push(join(root.dir, entry, rel));
    }
  }

  return [...fromEnv, ...staticPaths, ...cached];
}

export function findChromeBinary(): string | undefined {
  return chromeCandidates().find(candidate => existsSync(candidate));
}

function cardBody(card: CardSpec): string {
  const type = card.type || 'cover';

  if (type === 'point') {
    return `
      ${card.index ? `<div class="idx">${escapeHtml(card.index)}</div>` : ''}
      ${card.heading ? `<h2>${inlineEmphasis(card.heading)}</h2>` : ''}
      ${card.body ? `<p class="body">${inlineEmphasis(card.body)}</p>` : ''}`;
  }

  if (type === 'list') {
    const items = (card.items || [])
      .slice(0, 6)
      .map(item => `<li>${inlineEmphasis(item)}</li>`)
      .join('');
    return `
      ${card.heading ? `<h2>${inlineEmphasis(card.heading)}</h2>` : ''}
      ${items ? `<ul>${items}</ul>` : ''}`;
  }

  if (type === 'end') {
    return `
      ${card.heading ? `<h2 class="end">${inlineEmphasis(card.heading)}</h2>` : ''}
      ${card.body ? `<p class="body">${inlineEmphasis(card.body)}</p>` : ''}`;
  }

  // cover
  return `
    ${card.tag ? `<span class="tag">${escapeHtml(card.tag)}</span>` : ''}
    ${card.title ? `<h1>${inlineEmphasis(card.title)}</h1>` : ''}
    ${card.subtitle ? `<p class="sub">${inlineEmphasis(card.subtitle)}</p>` : ''}`;
}

function cardHtml(card: CardSpec, theme: keyof typeof THEMES): string {
  const t = THEMES[theme] || THEMES.warm;
  const type = card.type || 'cover';
  const tip = type === 'point' || type === 'list' ? card.tip : undefined;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;font-family:${FONT_STACK};
  background:${t.bg};color:${t.text};padding:96px 84px;display:flex;flex-direction:column;overflow:hidden}
main{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.tag{display:inline-block;background:${t.accent};color:#fff;font-size:32px;font-weight:600;
  padding:14px 34px;border-radius:100px;align-self:flex-start}
h1{font-size:86px;line-height:1.28;font-weight:800;margin-top:52px;letter-spacing:-1px}
h2{font-size:64px;line-height:1.34;font-weight:800;margin-top:28px}
h2.end{font-size:72px}
.sub{font-size:40px;line-height:1.68;color:${t.muted};margin-top:48px}
.body{font-size:42px;line-height:1.76;color:${t.muted};margin-top:40px;white-space:pre-line}
.idx{font-size:104px;font-weight:800;color:${t.accent};line-height:1}
.hl{color:${t.accent}}
ul{margin-top:44px;list-style:none}
li{font-size:42px;line-height:1.58;color:${t.muted};margin-bottom:34px;padding-left:52px;position:relative}
li:last-child{margin-bottom:0}
li::before{content:"✅";position:absolute;left:0;top:2px;font-size:36px}
.tip{flex:none;margin-top:56px;background:${t.card};border-left:10px solid ${t.accent};border-radius:20px;
  padding:34px 38px;font-size:36px;line-height:1.6;color:${t.text}}
</style></head><body><main>${cardBody(card)}</main>${
    tip ? `<div class="tip">💡 ${inlineEmphasis(tip)}</div>` : ''
  }</body></html>`;
}

export interface RenderedCards {
  paths: string[];
  chromeBinary: string;
}

/**
 * Render every card to a PNG inside `outDir` and return their absolute paths.
 * Throws with an actionable message when no Chromium is available, so the
 * caller surfaces a real failure instead of silently producing no images.
 */
export async function renderCards(
  spec: CardRenderSpec,
  outDir: string,
  options: { timeoutMs?: number } = {},
): Promise<RenderedCards> {
  const cards = (spec.cards || []).slice(0, 12);
  if (cards.length === 0) throw new Error('image.generate_cards requires a non-empty "cards" array');

  const chrome = findChromeBinary();
  if (!chrome) {
    throw new Error(
      'No Chrome/Chromium binary found for card rendering. Install Google Chrome, '
      + 'or set CHROME_BIN to a Chromium executable.',
    );
  }

  const theme = (spec.theme && spec.theme in THEMES ? spec.theme : 'warm') as keyof typeof THEMES;
  mkdirSync(outDir, { recursive: true });

  const paths: string[] = [];
  for (const [index, card] of cards.entries()) {
    const slug = String(index + 1).padStart(2, '0');
    const htmlPath = join(outDir, `card-${slug}.html`);
    const pngPath = join(outDir, `card-${slug}.png`);
    writeFileSync(htmlPath, cardHtml(card, theme), 'utf-8');

    await execFileAsync(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${pngPath}`,
      `--window-size=${CARD_WIDTH},${CARD_HEIGHT}`,
      `file://${htmlPath}`,
    ], { timeout: options.timeoutMs ?? 30_000 });

    if (!existsSync(pngPath)) throw new Error(`Card ${slug} failed to render to PNG`);
    paths.push(pngPath);
  }

  return { paths, chromeBinary: chrome };
}
