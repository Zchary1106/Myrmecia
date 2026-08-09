#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = process.env.GITHUB_REPOSITORY || 'Zchary1106/Myrmecia';
const [owner, repo] = repository.split('/');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

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
  return new Intl.NumberFormat('en', {
    notation: value >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function formatAxisDate(timestamp, span) {
  return new Intl.DateTimeFormat('en', span < 365 * 24 * 60 * 60 * 1_000
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', timeZone: 'UTC' }
  ).format(new Date(timestamp));
}

function renderSvg({ createdAt, stargazers, theme }) {
  const width = 960;
  const height = 480;
  const plot = { left: 82, right: 42, top: 104, bottom: 70 };
  const chartWidth = width - plot.left - plot.right;
  const chartHeight = height - plot.top - plot.bottom;
  const colors = theme === 'dark'
    ? {
        background: '#0d1117',
        panel: '#161b22',
        border: '#30363d',
        grid: '#30363d',
        text: '#f0f6fc',
        muted: '#8b949e',
        line: '#a78bfa',
        area: '#7c3aed',
        dot: '#c4b5fd',
      }
    : {
        background: '#ffffff',
        panel: '#f6f8fa',
        border: '#d0d7de',
        grid: '#d8dee4',
        text: '#1f2328',
        muted: '#656d76',
        line: '#7c3aed',
        area: '#8b5cf6',
        dot: '#6d28d9',
      };

  const sorted = stargazers
    .map(item => Date.parse(item.starred_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const created = Date.parse(createdAt);
  const oneDay = 24 * 60 * 60 * 1_000;
  const firstTime = Number.isFinite(created) ? created : (sorted[0] || Date.now());
  const lastActivity = sorted.at(-1) || firstTime;
  const lastTime = Math.max(lastActivity, firstTime + oneDay);
  const timeSpan = lastTime - firstTime;
  const totalStars = sorted.length;
  const maxY = Math.max(totalStars, 1);
  const scaleX = timestamp => plot.left + ((timestamp - firstTime) / (lastTime - firstTime)) * chartWidth;
  const scaleY = count => plot.top + chartHeight - (count / maxY) * chartHeight;

  const history = [{ timestamp: firstTime, count: 0 }];
  sorted.forEach((timestamp, index) => history.push({ timestamp, count: index + 1 }));

  let linePath = `M ${scaleX(history[0].timestamp).toFixed(2)} ${scaleY(0).toFixed(2)}`;
  for (const point of history.slice(1)) {
    linePath += ` H ${scaleX(point.timestamp).toFixed(2)} V ${scaleY(point.count).toFixed(2)}`;
  }
  linePath += ` H ${scaleX(lastTime).toFixed(2)}`;
  const areaPath = `${linePath} V ${scaleY(0).toFixed(2)} H ${scaleX(firstTime).toFixed(2)} Z`;

  const yTickCount = Math.min(5, maxY);
  const yTicks = [...new Set(
    Array.from({ length: yTickCount + 1 }, (_, index) => Math.round((maxY * index) / yTickCount)),
  )].sort((a, b) => a - b);
  const xTicks = Array.from({ length: 5 }, (_, index) =>
    firstTime + ((lastTime - firstTime) * index) / 4);

  const gridLines = [
    ...yTicks.map(value => {
      const y = scaleY(value).toFixed(2);
      return `<line x1="${plot.left}" y1="${y}" x2="${width - plot.right}" y2="${y}" stroke="${colors.grid}" stroke-width="1" stroke-dasharray="4 6"/>
      <text x="${plot.left - 16}" y="${Number(y) + 4}" fill="${colors.muted}" font-size="12" text-anchor="end">${compactNumber(value)}</text>`;
    }),
    ...xTicks.map((timestamp, index) => {
      const x = scaleX(timestamp).toFixed(2);
      const anchor = index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle';
      return `<text x="${x}" y="${height - 34}" fill="${colors.muted}" font-size="12" text-anchor="${anchor}">${escapeXml(formatAxisDate(timestamp, timeSpan))}</text>`;
    }),
  ].join('\n      ');

  const dots = history.slice(1).map(point =>
    `<circle cx="${scaleX(point.timestamp).toFixed(2)}" cy="${scaleY(point.count).toFixed(2)}" r="4" fill="${colors.dot}" stroke="${colors.background}" stroke-width="2"/>`,
  ).join('\n      ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(repository)} star history</title>
  <desc id="description">Static chart showing ${totalStars} GitHub stars from ${formatDate(firstTime)} through ${formatDate(lastActivity)}.</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${colors.area}" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="${colors.area}" stop-opacity="0.03"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="${colors.background}"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="17" fill="none" stroke="${colors.border}"/>
  <text x="${plot.left}" y="47" fill="${colors.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="700">Star History</text>
  <text x="${plot.left}" y="72" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="13">${escapeXml(repository)} · generated by GitHub Actions</text>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
      ${gridLines}
      <path d="${areaPath}" fill="url(#area)"/>
      <path d="${linePath}" fill="none" stroke="${colors.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
      ${dots}
  </g>
  <g transform="translate(${width - 194} 30)">
    <rect width="152" height="52" rx="12" fill="${colors.panel}" stroke="${colors.border}"/>
    <text x="14" y="20" fill="${colors.muted}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11">TOTAL STARS</text>
    <text x="14" y="42" fill="${colors.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="21" font-weight="700">${compactNumber(totalStars)}</text>
  </g>
</svg>
`;
}

const metadata = await github(`/repos/${owner}/${repo}`);
const stargazers = await listStargazers();

if (typeof metadata.created_at !== 'string') {
  throw new Error('GitHub repository metadata did not include created_at.');
}
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, 'docs', 'assets');
await mkdir(outputDir, { recursive: true });

for (const theme of ['light', 'dark']) {
  const output = join(outputDir, `star-history-${theme}.svg`);
  await writeFile(output, renderSvg({
    createdAt: metadata.created_at,
    stargazers,
    theme,
  }), 'utf8');
  console.log(`Generated ${output}`);
}
