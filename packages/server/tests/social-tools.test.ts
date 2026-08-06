import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import sharp from 'sharp';
import { executeTool } from '../src/skills/tool-sandbox.js';

describe('social workflow deterministic tools', () => {
  it('inspects generated image dimensions and metadata', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'social-media-inspect-'));
    const imagePath = join(workdir, 'card.png');
    await sharp({
      create: {
        width: 1080,
        height: 1440,
        channels: 3,
        background: '#ffffff',
      },
    }).png().toFile(imagePath);

    const result = await executeTool('media.inspect', { path: 'card.png' }, workdir, {
      allowedTools: ['media.inspect'],
    });
    expect(result.status).toBe('done');
    expect(JSON.parse(result.output)).toMatchObject({
      exists: true,
      media_type: 'image',
      format: 'png',
      width: 1080,
      height: 1440,
    });
  });

  it('applies the deterministic compliance rulebook', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'social-compliance-'));
    const target = join(workdir, 'docs/social-workflow/compliance-rules.yaml');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(resolve(process.cwd(), '../../docs/social-workflow/compliance-rules.yaml'), 'utf8'),
      'utf8',
    );

    const result = await executeTool('content.compliance_check', {
      content_id: 'social-20260804-test-1',
      workspace_id: 'default',
      documents: [{
        platform: 'xiaohongshu',
        title: '全网第一的工具',
        body: '保证有效，加微信领取。',
      }],
    }, workdir, {
      allowedTools: ['content.compliance_check'],
    });
    const report = JSON.parse(result.output);
    expect(result.status).toBe('done');
    expect(report.status).toBe('blocked');
    expect(report.findings.length).toBeGreaterThan(0);
  });

  it('does not allow a tool call to cross the task workspace boundary', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'social-workspace-scope-'));
    const result = await executeTool('social.schedule_check', {
      workspace_id: 'workspace-b',
      platform: 'douyin',
      account_id: 'account-1',
      schedule_at: '2026-08-05T10:00:00.000Z',
    }, workdir, {
      allowedTools: ['social.schedule_check'],
      workspaceId: 'workspace-a',
    });

    expect(result.status).toBe('failed');
    expect(result.output).toContain('does not match');
  });
});
