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
import { pathToFileURL } from 'url';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;
export const WECHAT_COVER_WIDTH = 900;
export const WECHAT_COVER_HEIGHT = 383;

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
  theme?: 'warm' | 'clean' | 'dark' | 'tech' | 'editorial' | 'notebook';
}

export interface WeChatCoverSpec {
  title: string;
  subtitle?: string;
  theme?: 'warm' | 'clean' | 'dark';
}

const THEMES = {
  warm: { bg: 'linear-gradient(160deg,#FFF8F0 0%,#FFE8E0 100%)', accent: '#FF2E4D', text: '#1a1a1a', muted: '#555', card: 'rgba(255,255,255,.72)' },
  clean: { bg: 'linear-gradient(160deg,#F5F9FF 0%,#E8F0FE 100%)', accent: '#2563eb', text: '#111827', muted: '#4b5563', card: 'rgba(255,255,255,.8)' },
  dark: { bg: 'linear-gradient(160deg,#1f2430 0%,#11141c 100%)', accent: '#FF6B81', text: '#f8fafc', muted: '#c3c9d5', card: 'rgba(255,255,255,.08)' },
  tech: {
    bg: 'radial-gradient(circle at 84% 10%,rgba(38,208,255,.24),transparent 26%),radial-gradient(circle at 8% 92%,rgba(124,92,255,.24),transparent 28%),linear-gradient(rgba(74,144,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(74,144,255,.08) 1px,transparent 1px),linear-gradient(145deg,#0C1221 0%,#151B30 100%)',
    accent: '#53D8FF',
    text: '#F7FAFF',
    muted: '#B9C6DE',
    card: 'rgba(83,216,255,.10)',
  },
  editorial: {
    bg: 'radial-gradient(circle at 92% 8%,rgba(210,56,46,.12),transparent 24%),linear-gradient(155deg,#F7F0E5 0%,#EFE4D2 100%)',
    accent: '#C9342C',
    text: '#201D19',
    muted: '#625A51',
    card: 'rgba(255,255,255,.62)',
  },
  notebook: {
    bg: 'linear-gradient(rgba(48,95,74,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(48,95,74,.09) 1px,transparent 1px),linear-gradient(160deg,#FFFDF0 0%,#F3F7E8 100%)',
    accent: '#217A57',
    text: '#1D2923',
    muted: '#52645B',
    card: 'rgba(255,255,255,.72)',
  },
} as const;

const COVER_THEMES = {
  warm: { start: '#FFF8F0', end: '#FFE8E0', accent: '#FF2E4D', text: '#1a1a1a', muted: '#555555' },
  clean: { start: '#F5F9FF', end: '#E8F0FE', accent: '#2563eb', text: '#111827', muted: '#4b5563' },
  dark: { start: '#1f2430', end: '#11141c', accent: '#FF6B81', text: '#f8fafc', muted: '#c3c9d5' },
} as const;

const FONT_STACK = `"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei","Heiti SC",sans-serif`;
const SVG_FONT_STACK = 'PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Source Han Sans SC, Microsoft YaHei, Heiti SC, sans-serif';

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
  background:${t.bg};background-size:auto,auto,54px 54px,54px 54px,auto;color:${t.text};
  padding:96px 84px;display:flex;flex-direction:column;overflow:hidden}
main{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.tag{display:inline-block;background:${t.accent};color:#fff;font-size:32px;font-weight:600;
  padding:14px 34px;border-radius:100px;align-self:flex-start}
h1{font-size:86px;line-height:1.28;font-weight:800;margin-top:52px;letter-spacing:-1px;white-space:pre-line}
h2{font-size:64px;line-height:1.34;font-weight:800;margin-top:28px;white-space:pre-line}
h2.end{font-size:72px}
.sub{font-size:40px;line-height:1.68;color:${t.muted};margin-top:48px;white-space:pre-line}
.body{font-size:42px;line-height:1.76;color:${t.muted};margin-top:40px;white-space:pre-line}
.idx{font-size:104px;font-weight:800;color:${t.accent};line-height:1}
.hl{color:${t.accent}}
ul{margin-top:44px;list-style:none}
li{font-size:42px;line-height:1.58;color:${t.muted};margin-bottom:34px;padding-left:52px;position:relative}
li:last-child{margin-bottom:0}
li::before{content:"●";position:absolute;left:0;top:2px;font-size:28px;color:${t.accent}}
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
      pathToFileURL(htmlPath).href,
    ], { timeout: options.timeoutMs ?? 30_000 });

    if (!existsSync(pngPath)) throw new Error(`Card ${slug} failed to render to PNG`);
    paths.push(pngPath);
  }

  return { paths, chromeBinary: chrome };
}

export async function renderWeChatCover(
  spec: WeChatCoverSpec,
  outDir: string,
  _options: { timeoutMs?: number } = {},
): Promise<{ path: string; renderer: string }> {
  if (!spec.title?.trim()) throw new Error('image.generate_wechat_cover requires a title');
  const theme = (spec.theme && spec.theme in COVER_THEMES ? spec.theme : 'clean') as keyof typeof COVER_THEMES;
  const colors = COVER_THEMES[theme];
  mkdirSync(outDir, { recursive: true });
  const svgPath = join(outDir, 'wechat-cover.svg');
  const pngPath = join(outDir, 'wechat-cover.png');
  const titleLines = wrapCoverTitle(spec.title);
  const subtitle = truncateCoverText(spec.subtitle || '', 42);
  const title = titleLines.map((line, index) =>
    `<tspan x="126" dy="${index === 0 ? 0 : 60}">${escapeHtml(line)}</tspan>`
  ).join('');
  const subtitleY = titleLines.length > 1 ? 330 : 282;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WECHAT_COVER_WIDTH}" height="${WECHAT_COVER_HEIGHT}" viewBox="0 0 ${WECHAT_COVER_WIDTH} ${WECHAT_COVER_HEIGHT}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${colors.start}"/>
      <stop offset="100%" stop-color="${colors.end}"/>
    </linearGradient>
  </defs>
  <rect width="900" height="383" fill="url(#background)"/>
  <circle cx="830" cy="42" r="118" fill="${colors.accent}" opacity="0.08"/>
  <circle cx="782" cy="364" r="82" fill="${colors.accent}" opacity="0.06"/>
  <rect x="72" y="82" width="10" height="220" rx="5" fill="${colors.accent}"/>
  <text x="126" y="92" font-family="${SVG_FONT_STACK}" font-size="20" font-weight="700" letter-spacing="4" fill="${colors.accent}">MYRMECIA · 公众号</text>
  <text x="126" y="172" font-family="${SVG_FONT_STACK}" font-size="48" font-weight="700" fill="${colors.text}">${title}</text>
  ${subtitle ? `<text x="126" y="${subtitleY}" font-family="${SVG_FONT_STACK}" font-size="22" fill="${colors.muted}">${escapeHtml(subtitle)}</text>` : ''}
</svg>`;
  writeFileSync(svgPath, svg, 'utf-8');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(pngPath);

  if (!existsSync(pngPath)) throw new Error('WeChat cover failed to render to PNG');
  return { path: pngPath, renderer: 'sharp/libvips' };
}

function wrapCoverTitle(value: string): string[] {
  const characters = Array.from(value.replace(/\*\*/g, '').trim());
  const lines: string[] = [];
  let current = '';
  let width = 0;
  for (const character of characters) {
    const characterWidth = /^[\x00-\xff]$/.test(character) ? 0.55 : 1;
    if (current && width + characterWidth > 15.5) {
      lines.push(current);
      current = '';
      width = 0;
      if (lines.length === 2) break;
    }
    current += character;
    width += characterWidth;
  }
  if (current && lines.length < 2) lines.push(current);
  if (lines.length === 2 && characters.join('').length > lines.join('').length) {
    lines[1] = `${Array.from(lines[1]).slice(0, -1).join('')}…`;
  }
  return lines;
}

function truncateCoverText(value: string, maxLength: number): string {
  const characters = Array.from(value.replace(/\*\*/g, '').trim());
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join('')}…`
    : characters.join('');
}
