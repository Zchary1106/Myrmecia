#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = process.env.GITHUB_REPOSITORY || 'Zchary1106/Myrmecia';
const [owner, repo] = repository.split('/');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!owner || !repo) {
  throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
}
if (!token) {
  throw new Error('GITHUB_TOKEN or GH_TOKEN is required to read timestamped stargazer data.');
}

const headers = {
  Accept: 'application/vnd.github.star+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'myrmecia-star-history-generator',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function fetchDataUrl(url) {
  if (!url) throw new Error('GitHub repository metadata did not include an owner avatar.');
  const response = await fetch(url, {
    headers: {
      'User-Agent': headers['User-Agent'],
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch repository owner avatar: HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
}

async function listStargazers() {
  const stargazers = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(`/repos/${owner}/${repo}/stargazers?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid stargazer payload.');
    stargazers.push(...batch);
    if (batch.length < 100) break;
  }
  return stargazers;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function compactNumber(value) {
  if (value >= 1_000_000) {
    return value % 1_000_000 === 0 ? `${value / 1_000_000}M` : `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return value % 1_000 === 0 ? `${value / 1_000}K` : `${(value / 1_000).toFixed(1)}K`;
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatAxisDate(timestamp, span) {
  const options = span < 45 * 24 * 60 * 60 * 1_000
    ? { month: 'short', day: '2-digit', timeZone: 'UTC' }
    : span < 2 * 365 * 24 * 60 * 60 * 1_000
      ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en', options).format(new Date(timestamp));
}

function linearTicks(max, requested = 5) {
  if (max <= 0) return [0];
  const rough = max / requested;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const step = (
    normalized >= Math.sqrt(50) ? 10
      : normalized >= Math.sqrt(10) ? 5
        : normalized >= Math.sqrt(2) ? 2
          : 1
  ) * power;
  const ticks = [];
  for (let value = 0; value <= max + step * 0.01; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

function smoothPath(points) {
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  }
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const previous = points[index - 1] || current;
    const after = points[index + 2] || next;
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = current.y + (next.y - previous.y) / 6;
    const control2X = next.x - (after.x - current.x) / 6;
    const control2Y = next.y - (after.y - current.y) / 6;
    path += ` C ${control1X.toFixed(2)} ${control1Y.toFixed(2)}, ${control2X.toFixed(2)} ${control2Y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return path;
}

function renderSvg({ stargazers, theme, avatarDataUrl, fontDataUrl, watermarkIconDataUrl }) {
  // These dimensions, margins, colors, typography, legend and sketch filter
  // intentionally mirror the open-source Star History SVG renderer.
  const width = 800;
  const height = (width * 2) / 3;
  const margin = { top: 60, right: 30, bottom: 50, left: 70 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const dark = theme === 'dark';
  const background = dark ? '#0d1117' : '#ffffff';
  const stroke = dark ? '#ffffff' : '#000000';
  const lineColor = dark ? '#ff6b6b' : '#dd4528';

  const sorted = stargazers
    .map(item => Date.parse(item.starred_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const now = Date.now();
  const firstTime = sorted[0] ?? now - 24 * 60 * 60 * 1_000;
  const lastActivity = sorted.at(-1) ?? now;
  const lastTime = Math.max(lastActivity, firstTime + 24 * 60 * 60 * 1_000);
  const span = lastTime - firstTime;
  const maxStars = Math.max(sorted.length, 1);
  const scaleX = timestamp => ((timestamp - firstTime) / span) * chartWidth;
  const scaleY = count => chartHeight - (count / maxStars) * chartHeight;
  const history = sorted.length > 0
    ? sorted.map((timestamp, index) => ({ timestamp, count: index + 1 }))
    : [{ timestamp: firstTime, count: 0 }, { timestamp: lastTime, count: 0 }];
  const points = history.map(point => ({
    x: scaleX(point.timestamp),
    y: scaleY(point.count),
  }));

  const yTicks = linearTicks(maxStars, 5);
  const xTicks = Array.from({ length: 5 }, (_, index) => firstTime + (span * index) / 4);
  const xAxis = xTicks.map((timestamp, index) => {
    const x = scaleX(timestamp);
    const anchor = index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';
    return `<g class="tick" transform="translate(${x.toFixed(2)},0)">
          <text fill="${stroke}" y="9" dy="0.71em" text-anchor="${anchor}">${escapeXml(formatAxisDate(timestamp, span))}</text>
        </g>`;
  }).join('\n        ');
  const yAxis = yTicks.map(value => {
    const y = scaleY(value);
    return `<g class="tick" transform="translate(0,${y.toFixed(2)})">
          <line stroke="${stroke}" x2="-1"/>
          <text fill="${stroke}" x="-7" dy="0.32em" text-anchor="end">${value === 0 ? ' ' : compactNumber(value)}</text>
        </g>`;
  }).join('\n        ');

  const legendTextWidth = repository.length * 7.5;
  const legendWidth = Math.max(legendTextWidth + 36, repository.length * 7 + 36);
  const titleLogoX = width * 0.5 - 84;
  const titleClipX = width * 0.5 - 73;
  const titleLogoClip = avatarDataUrl
    ? `<clipPath id="clip-circle-title"><circle r="11" cx="${titleClipX}" cy="23"/></clipPath>`
    : '';
  const titleLogoImage = avatarDataUrl
    ? `<image x="${titleLogoX}" y="12" width="22" height="22" href="${avatarDataUrl}" clip-path="url(#clip-circle-title)"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="title description" style="stroke-width:3;font-family:xkcd;background:${background}">
  <title id="title">${escapeXml(repository)} Star History</title>
  <desc id="description">GitHub star history for ${escapeXml(repository)}, rendered in the Star History chart style.</desc>
  <defs>
    <style>
      @font-face { font-family: xkcd; src: url("${fontDataUrl}") format("woff"); }
      text { font-family: xkcd, "Comic Sans MS", cursive; }
    </style>
    <filter id="xkcdify" filterUnits="userSpaceOnUse" x="-5" y="-5" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.05" result="noise"/>
      <feDisplacementMap scale="5" xChannelSelector="R" yChannelSelector="G" in="SourceGraphic" in2="noise"/>
    </filter>
${titleLogoClip}
  </defs>
  <rect width="${width}" height="${height}" fill="${background}"/>
  <text x="50%" y="30" text-anchor="middle" fill="${stroke}" font-size="20" font-weight="bold">Star History</text>
${titleLogoImage}
  <text x="50%" y="${height - 10}" text-anchor="middle" fill="${stroke}" font-size="17">Date</text>
  <text text-anchor="end" dy=".75em" transform="rotate(-90)" fill="${stroke}" font-size="17" y="24" x="-${Math.floor(height / 2 - 50)}">GitHub Stars</text>
  <g transform="translate(${margin.left},${margin.top})" pointer-events="all">
    <g class="xaxis" transform="translate(0,${chartHeight})">
      <path class="domain" stroke="${stroke}" d="M0,0.5H${chartWidth}" fill="none" filter="url(#xkcdify)"/>
      <g font-size="16" fill="none" text-anchor="middle">${xAxis}</g>
    </g>
    <g class="yaxis">
      <path class="domain" stroke="${stroke}" d="M-0.5,${chartHeight}V0" fill="none" filter="url(#xkcdify)"/>
      <g font-size="16" fill="none" text-anchor="end">${yAxis}</g>
    </g>
    <path class="xkcd-chart-xyline" d="${smoothPath(points)}" fill="none" stroke="${lineColor}" filter="url(#xkcdify)"/>
    <svg>
      <svg>
        <rect x="8" y="5" width="${legendWidth.toFixed(2)}" height="32" rx="5" ry="5" fill="${background}" fill-opacity="0.85" stroke="${stroke}" stroke-width="2" filter="url(#xkcdify)"/>
      </svg>
      <svg>
        <rect x="15" y="17" width="8" height="8" rx="2" ry="2" fill="${lineColor}" filter="url(#xkcdify)"/>
        <text x="29" y="25" fill="${stroke}" font-size="15">${escapeXml(repository)}</text>
      </svg>
    </svg>
    <image x="${chartWidth - 135}" y="${chartHeight + 25}" width="20" height="20" href="${watermarkIconDataUrl}"/>
    <text transform="translate(${chartWidth - 50},${chartHeight + 40})" text-anchor="middle" fill="#666666" font-size="16">star-history.com</text>
  </g>
</svg>
`;
}

const metadata = await github(`/repos/${owner}/${repo}`);
const stargazers = await listStargazers();

if (stargazers.some(stargazer => typeof stargazer.starred_at !== 'string')) {
  throw new Error(
    'GitHub did not return timestamped stargazer data. Confirm that the workflow token can read this repository.',
  );
}
if (Number.isFinite(metadata.stargazers_count) && stargazers.length !== metadata.stargazers_count) {
  console.warn(
    `GitHub reports ${metadata.stargazers_count} stars while this run fetched ${stargazers.length}; ` +
    'using the timestamped result because the count may have changed during pagination.',
  );
}

const [fontBuffer, watermarkIconBuffer, avatarDataUrl] = await Promise.all([
  readFile(join(root, 'scripts', 'assets', 'xkcd.woff')),
  readFile(join(root, 'scripts', 'assets', 'star-history-icon.png')),
  fetchDataUrl(metadata.owner?.avatar_url ? `${metadata.owner.avatar_url}&s=44` : ''),
]);
const fontDataUrl = `data:application/font-woff;base64,${fontBuffer.toString('base64')}`;
const watermarkIconDataUrl = `data:image/png;base64,${watermarkIconBuffer.toString('base64')}`;
const outputDir = join(root, 'docs', 'assets');
await mkdir(outputDir, { recursive: true });

for (const theme of ['light', 'dark']) {
  const output = join(outputDir, `star-history-${theme}.svg`);
  await writeFile(output, renderSvg({
    stargazers,
    theme,
    avatarDataUrl,
    fontDataUrl,
    watermarkIconDataUrl,
  }), 'utf8');
  console.log(`Generated ${output}`);
}
