/**
 * ComfyUI image generation.
 *
 * Renders illustrations for social posts by driving a local ComfyUI server over
 * its HTTP API, complementing `image.generate_cards`: cards carry the text, this
 * carries the artwork (covers, backgrounds, scene illustrations).
 *
 * Why HTTP and not MCP: ComfyUI speaks HTTP, our MCP client only speaks stdio,
 * so going through MCP would mean running an `mcp-remote` bridge for three
 * endpoints. We submit a prompt graph, poll history, then download the results
 * into the task workspace.
 *
 * Model choice is not arbitrary. Measured on the local M2 Max / 32GB box at a comparable
 * resolution: SDXL takes ~55s per image, while FLUX.1-dev fp8 loads 22.7GB and
 * takes 80-105s *per step* (~30 min per image) because it exhausts unified
 * memory. A six-image set is ~5 min on SDXL versus ~3 hours on FLUX, so SDXL is
 * the only viable default for a pipeline stage.
 */

import { createWriteStream, existsSync, mkdirSync, openSync } from 'fs';
import { spawn } from 'child_process';
import { homedir, tmpdir } from 'os';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { WebSocket } from 'ws';

export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/**
 * Xiaohongshu's feed is 3:4. 896x1200 holds that ratio exactly while staying
 * near SDXL's ~1M-pixel training resolution and divisible by 8, which the VAE
 * requires. (SDXL's own 832x1216 preset is 0.68, not 3:4, so it would be
 * letterboxed in the feed.)
 */
export const DEFAULT_WIDTH = 896;
export const DEFAULT_HEIGHT = 1200;

const MAX_IMAGES = 6;
const DEFAULT_STEPS = 25;
const POLL_INTERVAL_MS = 3_000;

/** Minimum gap between progress reports, so a long batch can't flood the log. */
const PROGRESS_THROTTLE_MS = 5_000;

/**
 * Keeping text out of generated art is deliberate: diffusion models render CJK
 * glyphs as unreadable pseudo-characters, and the copy is already handled by
 * `image.generate_cards`.
 */
const BASE_NEGATIVE = 'text, words, letters, watermark, signature, logo, blurry, low quality, distorted, deformed, ugly, extra limbs';

export interface ComfyPrompt {
  prompt: string;
  negative?: string;
}

export interface ComfyGenerateSpec {
  prompts: (string | ComfyPrompt)[];
  style?: keyof typeof STYLE_PRESETS;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}

export const STYLE_PRESETS = {
  illustration: 'flat vector illustration, minimalist infographic style, clean geometric shapes, soft muted palette, editorial poster, generous negative space',
  photo: 'photorealistic, natural soft lighting, shallow depth of field, lifestyle photography, high detail',
  anime: 'anime illustration, cel shading, clean linework, vibrant colours, studio quality',
  watercolor: 'delicate watercolour painting, soft gradients, paper texture, gentle pastel tones',
} as const;

export interface ComfyImage {
  path: string;
  prompt: string;
  seed: number;
}

export interface ComfyGenerateResult {
  images: ComfyImage[];
  model: string;
  elapsedMs: number;
  /** True when this call had to start the ComfyUI server itself. */
  autoStarted: boolean;
}

export interface ComfyProgress {
  /** Which image of the batch, 1-based. */
  imageIndex: number;
  imageCount: number;
  /** Sampling step within the current image; 0 while the phase has no steps. */
  step: number;
  stepCount: number;
  /** Overall completion across the whole batch, 0-1. */
  ratio: number;
  phase: 'starting' | 'queued' | 'sampling' | 'saving' | 'done';
  /** Human-readable one-liner, e.g. "配图 2/3 · 采样 12/25 (48%)". */
  message: string;
}

export type ComfyProgressHandler = (progress: ComfyProgress) => void;

/** Renders a short text bar so progress is legible in a plain log line. */
export function progressBar(ratio: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${String(Math.round(clamped * 100)).padStart(3)}%`;
}

function buildProgress(
  imageIndex: number,
  imageCount: number,
  step: number,
  stepCount: number,
  phase: ComfyProgress['phase'],
): ComfyProgress {
  // Weight each image equally, and the steps within it proportionally, so the
  // bar advances smoothly across a multi-image batch instead of jumping.
  const perImage = imageCount > 0 ? 1 / imageCount : 1;
  const within = stepCount > 0 ? Math.min(1, step / stepCount) : (phase === 'done' ? 1 : 0);
  const ratio = Math.min(1, (imageIndex - 1) * perImage + within * perImage);

  const label = phase === 'sampling' && stepCount > 0
    ? `采样 ${step}/${stepCount}`
    : { starting: '启动 ComfyUI', queued: '排队中', saving: '保存中', done: '完成', sampling: '采样中' }[phase];

  return {
    imageIndex, imageCount, step, stepCount, ratio, phase,
    message: `配图 ${imageIndex}/${imageCount} · ${label} ${progressBar(ratio)}`,
  };
}

export function comfyBaseUrl(): string {
  return (process.env.COMFYUI_URL || DEFAULT_COMFYUI_URL).replace(/\/+$/, '');
}

export function comfyCheckpoint(): string {
  return process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors';
}

/**
 * Clamp to multiples of 8; SDXL's VAE downsamples by 8 and rejects other sizes.
 */
function normalizeDimension(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(512, Math.min(1536, Math.round(n / 8) * 8));
}

export function buildSdxlWorkflow(opts: {
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
  checkpoint: string;
  filenamePrefix: string;
}): Record<string, unknown> {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: opts.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: opts.width, height: opts.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: opts.positive, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative, clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: opts.seed,
        steps: opts.steps,
        cfg: 7.0,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1.0,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: opts.filenamePrefix, images: ['8', 0] } },
  };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ComfyUI ${init.method || 'GET'} ${new URL(url).pathname} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify the server is reachable before queueing work, so a stopped ComfyUI
 * surfaces as "start it" rather than as a poll timeout minutes later.
 */
export async function checkComfyAvailable(timeoutMs = 5_000): Promise<{ ok: boolean; detail: string }> {
  try {
    const stats = await fetchJson(`${comfyBaseUrl()}/system_stats`, { method: 'GET' }, timeoutMs);
    const device = stats?.devices?.[0]?.name || stats?.system?.os || 'unknown';
    return { ok: true, detail: `ComfyUI ${stats?.system?.comfyui_version || '?'} on ${device}` };
  } catch (err: any) {
    return { ok: false, detail: err?.message || String(err) };
  }
}

const COMFY_HOME_CANDIDATES = [
  join(homedir(), 'MyWork', 'ComfyUI'),
  join(homedir(), 'ComfyUI'),
  join(homedir(), 'Documents', 'ComfyUI'),
  join(homedir(), 'Applications', 'ComfyUI'),
  '/opt/ComfyUI',
];

/** A directory only counts as a ComfyUI install if it can actually be launched. */
function isComfyHome(dir: string): boolean {
  return Boolean(dir) && existsSync(join(dir, 'main.py'));
}

export function findComfyHome(): string | undefined {
  const configured = process.env.COMFYUI_HOME;
  if (configured) return isComfyHome(configured) ? configured : undefined;
  return COMFY_HOME_CANDIDATES.find(isComfyHome);
}

/**
 * ComfyUI's dependencies (torch, custom nodes) almost never live in the system
 * interpreter, so a bare `python3` is the last resort rather than the default.
 */
export function findComfyPython(home: string): string {
  const configured = process.env.COMFYUI_PYTHON;
  if (configured) return configured;
  const candidates = [
    join(home, 'venv', 'bin', 'python'),
    join(home, '.venv', 'bin', 'python'),
    join(homedir(), 'miniconda3', 'envs', 'comfyui', 'bin', 'python'),
    join(homedir(), 'anaconda3', 'envs', 'comfyui', 'bin', 'python'),
    join(homedir(), 'miniforge3', 'envs', 'comfyui', 'bin', 'python'),
  ];
  return candidates.find((p) => existsSync(p)) || 'python3';
}

/**
 * Autostart is on by default, but only ever does anything when a real install is
 * found, so machines without ComfyUI behave exactly as before.
 */
export function isAutostartEnabled(): boolean {
  const raw = (process.env.COMFYUI_AUTOSTART || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return true;
}

/** Spawning a local process cannot help a URL that points at another machine. */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/** Serialises concurrent callers so a burst of tool calls spawns one server. */
let startInFlight: Promise<{ ok: boolean; detail: string }> | null = null;

async function launchComfy(timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const home = findComfyHome();
  if (!home) {
    return { ok: false, detail: 'no ComfyUI install found (set COMFYUI_HOME)' };
  }

  const baseUrl = comfyBaseUrl();
  const port = new URL(baseUrl).port || '8188';
  const python = findComfyPython(home);
  const logPath = join(tmpdir(), 'myrmecia-comfyui.log');
  const logFd = openSync(logPath, 'a');

  // Detached: keep the server alive across pipeline runs. Restarting it per run
  // would pay the model-load cost every time, which dwarfs generation itself.
  const child = spawn(python, ['main.py', '--listen', '127.0.0.1', '--port', port], {
    cwd: home,
    // A proxy in the environment would otherwise intercept our own health checks
    // against 127.0.0.1 and return 502.
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    const health = await checkComfyAvailable(3_000);
    if (health.ok) {
      return { ok: true, detail: `${health.detail} (auto-started from ${home}, pid ${child.pid})` };
    }
  }

  return {
    ok: false,
    detail: `auto-start timed out after ${Math.round(timeoutMs / 1000)}s; see ${logPath}`,
  };
}

/**
 * Return a reachable ComfyUI, starting one if needed.
 *
 * The launch command is derived entirely from configuration and disk layout,
 * never from tool input, so an agent cannot influence what gets executed.
 */
export async function ensureComfyAvailable(startTimeoutMs = 180_000): Promise<{ ok: boolean; detail: string; autoStarted: boolean }> {
  const health = await checkComfyAvailable();
  if (health.ok) return { ...health, autoStarted: false };

  if (!isAutostartEnabled()) {
    return { ...health, autoStarted: false };
  }
  if (!isLocalUrl(comfyBaseUrl())) {
    return { ...health, autoStarted: false };
  }
  if (!findComfyHome()) {
    return { ...health, autoStarted: false };
  }

  if (!startInFlight) {
    startInFlight = launchComfy(startTimeoutMs).finally(() => { startInFlight = null; });
  }
  const started = await startInFlight;
  return { ...started, autoStarted: started.ok };
}

async function downloadImage(baseUrl: string, image: { filename: string; subfolder?: string; type?: string }, destPath: string, timeoutMs: number): Promise<void> {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/view?${params}`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`ComfyUI /view -> ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
  } finally {
    clearTimeout(timer);
  }
}

function resolvePrompt(entry: string | ComfyPrompt, style: string): { positive: string; negative: string } {
  const raw = typeof entry === 'string' ? { prompt: entry } : entry;
  const prompt = String(raw?.prompt || '').trim();
  if (!prompt) throw new Error('Each prompt must be a non-empty string');
  const extra = String(raw?.negative || '').trim();
  return {
    positive: style ? `${prompt}, ${style}` : prompt,
    negative: extra ? `${BASE_NEGATIVE}, ${extra}` : BASE_NEGATIVE,
  };
}

/**
 * Subscribe to ComfyUI's progress stream for one prompt.
 *
 * ComfyUI reports sampling progress only over its websocket ({value, max} per
 * step); the REST API just says "not finished yet". Progress is best-effort:
 * a websocket failure must never fail a generation that is otherwise fine, so
 * every error path here degrades to "no live progress" instead of throwing.
 */
function watchComfyProgress(
  baseUrl: string,
  clientId: string,
  onStep: (step: number, stepCount: number) => void,
): { close: () => void } {
  let socket: WebSocket | undefined;
  try {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    socket = new WebSocket(wsUrl);
    socket.addEventListener('message', (event: any) => {
      try {
        if (typeof event.data !== 'string') return; // preview image frames
        const msg = JSON.parse(event.data);
        if (msg?.type === 'progress' && msg.data) {
          onStep(Number(msg.data.value) || 0, Number(msg.data.max) || 0);
        }
      } catch {
        // a malformed frame is not worth failing the render over
      }
    });
    socket.addEventListener('error', () => { /* fall back to silent polling */ });
  } catch {
    socket = undefined;
  }

  return {
    close: () => {
      try { socket?.close(); } catch { /* already gone */ }
    },
  };
}

/**
 * Generate one image per prompt, sequentially. Sequential is intentional: the
 * box has a single GPU and concurrent jobs thrash unified memory rather than
 * finishing sooner.
 */
export async function generateComfyImages(
  spec: ComfyGenerateSpec,
  outDir: string,
  options: { timeoutMs?: number; onProgress?: ComfyProgressHandler } = {},
): Promise<ComfyGenerateResult> {
  const prompts = (spec.prompts || []).slice(0, MAX_IMAGES);
  if (prompts.length === 0) {
    throw new Error('image.generate_comfyui requires a non-empty "prompts" array');
  }

  // Start the clock before the health check: auto-starting the server can take
  // a while, and that time has to come out of the caller's budget rather than
  // being spent on top of it.
  const started = Date.now();
  const totalBudgetMs = options.timeoutMs ?? 900_000;
  const onProgress = options.onProgress;
  const report = (p: ComfyProgress) => {
    // A misbehaving progress consumer must not break generation.
    try { onProgress?.(p); } catch { /* ignore */ }
  };

  // Never spend more than a third of the budget getting the server up, so a
  // slow start still leaves room to actually render something.
  const startBudgetMs = Math.max(30_000, Math.min(180_000, Math.floor(totalBudgetMs / 3)));

  report(buildProgress(1, prompts.length, 0, 0, 'starting'));
  const health = await ensureComfyAvailable(startBudgetMs);
  if (!health.ok) {
    const home = findComfyHome();
    const hint = !isAutostartEnabled()
      ? 'Auto-start is disabled (COMFYUI_AUTOSTART=false).'
      : home
        ? `Auto-start from ${home} did not come up in time.`
        : 'No ComfyUI install was found to auto-start — set COMFYUI_HOME.';
    throw new Error(
      `ComfyUI is not reachable at ${comfyBaseUrl()} (${health.detail}). ${hint} `
      + 'Start it manually with: cd <ComfyUI> && python main.py --listen 127.0.0.1 --port 8188. '
      + 'If a proxy is configured, NO_PROXY must include 127.0.0.1.',
    );
  }

  const baseUrl = comfyBaseUrl();
  const checkpoint = comfyCheckpoint();
  const style = STYLE_PRESETS[spec.style as keyof typeof STYLE_PRESETS] || STYLE_PRESETS.illustration;
  const width = normalizeDimension(spec.width, DEFAULT_WIDTH);
  const height = normalizeDimension(spec.height, DEFAULT_HEIGHT);
  const steps = Math.max(10, Math.min(40, Number(spec.steps) || DEFAULT_STEPS));

  mkdirSync(outDir, { recursive: true });

  const images: ComfyImage[] = [];

  for (const [index, entry] of prompts.entries()) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining <= 15_000) {
      if (images.length > 0) break;
      throw new Error('Ran out of time budget before any image finished');
    }

    const { positive, negative } = resolvePrompt(entry, style);
    const seed = Number.isFinite(spec.seed as number)
      ? Number(spec.seed) + index
      : Math.floor(Math.random() * 2_147_483_647);
    const slug = String(index + 1).padStart(2, '0');

    const workflow = buildSdxlWorkflow({
      positive, negative, width, height, steps, seed, checkpoint,
      filenamePrefix: `myrmecia_${slug}`,
    });

    const imageNo = index + 1;
    // A distinct client id per image keeps the progress stream scoped to this
    // job, so a browser tab or another caller can't leak steps into our bar.
    const clientId = `myrmecia-${Date.now()}-${slug}`;
    let lastReportedStep = -1;
    let lastReportAt = 0;
    const watcher = watchComfyProgress(baseUrl, clientId, (step, stepCount) => {
      if (step === lastReportedStep) return;
      const total = stepCount || steps;
      const isLast = step >= total;
      // Throttle: a 25-step image would otherwise emit 25 log lines, and a
      // multi-image batch would bury everything else in the task log.
      if (!isLast && Date.now() - lastReportAt < PROGRESS_THROTTLE_MS) return;
      lastReportedStep = step;
      lastReportAt = Date.now();
      report(buildProgress(imageNo, prompts.length, step, total, 'sampling'));
    });

    try {
      report(buildProgress(imageNo, prompts.length, 0, steps, 'queued'));

      const queued = await fetchJson(
        `${baseUrl}/prompt`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
        },
        30_000,
      );
      const promptId = queued?.prompt_id;
      if (!promptId) throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(queued).slice(0, 300)}`);

      const deadline = Date.now() + remaining;
      let outputs: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const history = await fetchJson(`${baseUrl}/history/${promptId}`, { method: 'GET' }, 15_000);
        const record = history?.[promptId];
        if (!record) continue;

        const status = record.status || {};
        if (status.status_str === 'error') {
          const detail = JSON.stringify(status.messages || []).slice(0, 500);
          throw new Error(`ComfyUI failed to execute the workflow: ${detail}`);
        }
        if (record.outputs) {
          outputs = record.outputs;
          break;
        }
      }

      if (!outputs) {
        if (images.length > 0) break;
        throw new Error(`Timed out waiting for ComfyUI to render image ${slug}`);
      }

      report(buildProgress(imageNo, prompts.length, steps, steps, 'saving'));

      const files = Object.values(outputs).flatMap((node: any) => node?.images || []);
      for (const [fileIndex, file] of files.entries()) {
        const ext = String(file.filename).split('.').pop() || 'png';
        const destPath = join(outDir, `art-${slug}${fileIndex > 0 ? `-${fileIndex}` : ''}.${ext}`);
        await downloadImage(baseUrl, file, destPath, 60_000);
        if (!existsSync(destPath)) throw new Error(`Failed to download ComfyUI output ${file.filename}`);
        images.push({ path: destPath, prompt: positive, seed });
      }

      // Intermediate images need no completion line: the next iteration's
      // "queued" report already announces the handover at the same ratio.
      if (imageNo === prompts.length) {
        report(buildProgress(imageNo, prompts.length, steps, steps, 'done'));
      }
    } finally {
      watcher.close();
    }
  }

  return { images, model: checkpoint, elapsedMs: Date.now() - started, autoStarted: health.autoStarted };
}
