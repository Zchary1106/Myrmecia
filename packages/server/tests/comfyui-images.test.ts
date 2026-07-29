import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSdxlWorkflow,
  checkComfyAvailable,
  generateComfyImages,
  comfyBaseUrl,
  findComfyHome,
  findComfyPython,
  isAutostartEnabled,
  ensureComfyAvailable,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
} from '../src/tools/comfyui-images.js';

describe('comfyui-images', () => {
  let workdir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'comfy-test-'));
    // Hermetic default: never let the suite spawn a real ComfyUI on a developer
    // machine that happens to have one installed. Autostart tests opt back in.
    process.env.COMFYUI_AUTOSTART = 'false';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.COMFYUI_URL;
    delete process.env.COMFYUI_CHECKPOINT;
    delete process.env.COMFYUI_HOME;
    delete process.env.COMFYUI_PYTHON;
    delete process.env.COMFYUI_AUTOSTART;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('builds a valid SDXL graph wired sampler -> decode -> save', () => {
    const wf = buildSdxlWorkflow({
      positive: 'a cat', negative: 'text', width: 832, height: 1216,
      steps: 25, seed: 7, checkpoint: 'sd_xl_base_1.0.safetensors', filenamePrefix: 'p',
    }) as any;

    expect(wf['4'].inputs.ckpt_name).toBe('sd_xl_base_1.0.safetensors');
    expect(wf['3'].inputs.seed).toBe(7);
    // the sampler must consume both text encoders and the empty latent
    expect(wf['3'].inputs.positive).toEqual(['6', 0]);
    expect(wf['3'].inputs.negative).toEqual(['7', 0]);
    expect(wf['3'].inputs.latent_image).toEqual(['5', 0]);
    // and the save node must consume the decoded image
    expect(wf['8'].inputs.samples).toEqual(['3', 0]);
    expect(wf['9'].inputs.images).toEqual(['8', 0]);
  });

  it('honours COMFYUI_URL and strips trailing slashes', () => {
    process.env.COMFYUI_URL = 'http://127.0.0.1:9999/';
    expect(comfyBaseUrl()).toBe('http://127.0.0.1:9999');
  });

  it('reports unavailable rather than throwing when the server is down', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
    const health = await checkComfyAvailable(100);
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('ECONNREFUSED');
  });

  it('rejects an empty prompt list before touching the network', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    await expect(generateComfyImages({ prompts: [] }, workdir)).rejects.toThrow(/non-empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tells the user how to start ComfyUI when it is unreachable', async () => {
    process.env.COMFYUI_AUTOSTART = 'false';
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as any;
    await expect(generateComfyImages({ prompts: ['a cat'] }, workdir))
      .rejects.toThrow(/not reachable.*python main\.py/s);
  });

  it('submits, polls, and downloads the rendered image into the workspace', async () => {
    const png = Buffer.from('fake-png-bytes');
    let historyCalls = 0;

    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/system_stats')) {
        return new Response(JSON.stringify({ system: { comfyui_version: '0.21.0' }, devices: [{ name: 'mps' }] }), { status: 200 });
      }
      if (u.includes('/prompt')) {
        const body = JSON.parse(init.body);
        // the workflow must carry our prompt through to the positive encoder
        expect(body.prompt['6'].inputs.text).toContain('a tidy desk');
        return new Response(JSON.stringify({ prompt_id: 'abc-123' }), { status: 200 });
      }
      if (u.includes('/history/')) {
        historyCalls += 1;
        // first poll: still running, no outputs yet
        if (historyCalls < 2) return new Response(JSON.stringify({}), { status: 200 });
        return new Response(JSON.stringify({
          'abc-123': { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } },
        }), { status: 200 });
      }
      if (u.includes('/view')) {
        return new Response(png, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    const result = await generateComfyImages(
      { prompts: ['a tidy desk'], style: 'illustration' },
      workdir,
      { timeoutMs: 60_000 },
    );

    expect(result.images).toHaveLength(1);
    expect(existsSync(result.images[0].path)).toBe(true);
    expect(readFileSync(result.images[0].path)).toEqual(png);
    expect(historyCalls).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('surfaces a workflow execution error instead of hanging until timeout', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/system_stats')) return new Response(JSON.stringify({ system: {}, devices: [] }), { status: 200 });
      if (u.includes('/prompt')) return new Response(JSON.stringify({ prompt_id: 'bad-1' }), { status: 200 });
      if (u.includes('/history/')) {
        return new Response(JSON.stringify({
          'bad-1': { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'model not found' }]] } },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as any;

    await expect(generateComfyImages({ prompts: ['x'] }, workdir, { timeoutMs: 30_000 }))
      .rejects.toThrow(/model not found/);
  }, 20_000);

  it('clamps dimensions to multiples of 8 so the SDXL VAE accepts them', async () => {
    let submitted: any = null;
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/system_stats')) return new Response(JSON.stringify({ system: {}, devices: [] }), { status: 200 });
      if (u.includes('/prompt')) {
        submitted = JSON.parse(init.body).prompt;
        return new Response(JSON.stringify({ prompt_id: 'dim-1' }), { status: 200 });
      }
      if (u.includes('/history/')) {
        return new Response(JSON.stringify({
          'dim-1': { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } },
        }), { status: 200 });
      }
      return new Response(Buffer.from('p'), { status: 200 });
    }) as any;

    await generateComfyImages({ prompts: ['x'], width: 831, height: 1213 }, workdir, { timeoutMs: 30_000 });
    expect(submitted['5'].inputs.width % 8).toBe(0);
    expect(submitted['5'].inputs.height % 8).toBe(0);
  }, 20_000);

  it('defaults to the 3:4 ratio Xiaohongshu expects', () => {
    expect(DEFAULT_WIDTH / DEFAULT_HEIGHT).toBeCloseTo(3 / 4, 2);
  });

  describe('autostart', () => {
    it('is on by default and can be switched off', () => {
      delete process.env.COMFYUI_AUTOSTART;
      expect(isAutostartEnabled()).toBe(true);
      for (const off of ['false', '0', 'no', 'off', 'OFF']) {
        process.env.COMFYUI_AUTOSTART = off;
        expect(isAutostartEnabled()).toBe(false);
      }
      process.env.COMFYUI_AUTOSTART = 'true';
      expect(isAutostartEnabled()).toBe(true);
    });

    it('rejects a COMFYUI_HOME that is not actually a ComfyUI install', () => {
      process.env.COMFYUI_HOME = workdir; // exists, but has no main.py
      expect(findComfyHome()).toBeUndefined();
    });

    it('accepts a COMFYUI_HOME containing main.py', () => {
      writeFileSync(join(workdir, 'main.py'), '# stub');
      process.env.COMFYUI_HOME = workdir;
      expect(findComfyHome()).toBe(workdir);
    });

    it('prefers an explicitly configured interpreter', () => {
      process.env.COMFYUI_PYTHON = '/custom/bin/python';
      expect(findComfyPython(workdir)).toBe('/custom/bin/python');
    });

    it('prefers a venv inside the install over the system interpreter', () => {
      mkdirSync(join(workdir, 'venv', 'bin'), { recursive: true });
      writeFileSync(join(workdir, 'venv', 'bin', 'python'), '#!/bin/sh');
      expect(findComfyPython(workdir)).toBe(join(workdir, 'venv', 'bin', 'python'));
    });

    it('does not spawn anything when autostart is disabled', async () => {
      process.env.COMFYUI_AUTOSTART = 'false';
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const res = await ensureComfyAvailable(1_000);
      expect(res.ok).toBe(false);
      expect(res.autoStarted).toBe(false);
    });

    it('does not try to spawn a local process for a remote ComfyUI', async () => {
      writeFileSync(join(workdir, 'main.py'), '# stub');
      process.env.COMFYUI_HOME = workdir;
      process.env.COMFYUI_AUTOSTART = 'true';
      process.env.COMFYUI_URL = 'http://192.168.1.50:8188';
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

      const res = await ensureComfyAvailable(1_000);
      expect(res.ok).toBe(false);
      expect(res.autoStarted).toBe(false);
    });

    it('skips the spawn entirely when the server already answers', async () => {
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ system: { comfyui_version: '0.21.0' }, devices: [{ name: 'mps' }] }), { status: 200 }),
      ) as any;

      const res = await ensureComfyAvailable(1_000);
      expect(res.ok).toBe(true);
      expect(res.autoStarted).toBe(false);
    });

    it('explains why it could not autostart when no install is present', async () => {
      process.env.COMFYUI_AUTOSTART = 'true';
      process.env.COMFYUI_HOME = workdir; // no main.py -> not an install
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(generateComfyImages({ prompts: ['x'] }, workdir, { timeoutMs: 30_000 }))
        .rejects.toThrow(/No ComfyUI install was found/);
    });
  });
});
