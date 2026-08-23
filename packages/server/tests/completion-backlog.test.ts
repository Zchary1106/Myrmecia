import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { closeDb, getDb } from '../src/db/database.js';
import { EmailChannel } from '../src/notifications/channels.js';
import { dlpRuleEngine } from '../src/security/dlp-rules.js';
import { createSource, syncSource, browseCatalog } from '../src/skills/skill-registry-service.js';
import { EvalFramework } from '../src/evaluation/eval-framework.js';
import { ModelGateway } from '../src/models/gateway.js';

describe('completed reliability backlog capabilities', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'myrmecia-completion-'));
    process.env.DB_PATH = join(root, 'test.db');
    getDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    delete process.env.DB_PATH;
    rmSync(root, { recursive: true, force: true });
  });

  it('delivers SMTP notifications through a configured transporter', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'message-1' });
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail } as any);
    const channel = new EmailChannel({ host: 'smtp.example.test', port: 587, username: 'mailer', password: 'secret', to: 'ops@example.test' });
    await expect(channel.send({ title: 'Task finished', body: 'Done', event: 'task.done' })).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.test', subject: 'Task finished' }));
  });

  it('syncs markdown skills from an administrator-selected local directory', async () => {
    const sourceDir = join(root, 'skill-source');
    const nested = join(sourceDir, 'nested');
    writeFileSync(join(root, 'placeholder'), '');
    await (await import('node:fs/promises')).mkdir(nested, { recursive: true });
    writeFileSync(join(nested, 'SKILL.md'), '# Local skill\n\nA locally synced skill.');
    const source = createSource({ name: 'Local', type: 'local', url: sourceDir });
    await expect(syncSource(source.id)).resolves.toEqual({ added: 1, updated: 0 });
    expect(browseCatalog({ sourceId: source.id })[0]).toMatchObject({ name: 'Local skill', path: 'nested/SKILL.md' });
  });

  it('detects configured sensitive named-entity classes without an LLM call', () => {
    const rule = dlpRuleEngine.addRule({ workspaceId: 'ws', name: 'secret detector', type: 'ner', pattern: 'email,api_key', action: 'block' });
    expect(dlpRuleEngine.evaluateContent('email jane@example.com', 'ws')).toMatchObject({ ruleId: rule.id, type: 'ner', action: 'block', matchedText: 'jane@example.com' });
    expect(dlpRuleEngine.evaluateContent('token github_pat_abcdefghijkabcdefghijkabcd', 'ws')).toMatchObject({ ruleId: rule.id, type: 'ner' });
  });

  it('uses the configured model gateway as the evaluation judge', async () => {
    vi.spyOn(ModelGateway.prototype, 'completeForModel').mockResolvedValue({
      choices: [{ message: { content: '{"score":0.8,"reason":"Complete and accurate"}' } }],
    } as any);
    const framework = new EvalFramework();
    const experiment = framework.createExperiment('judge', 'judge output', ['control'], { control: 100 });
    const result = await framework.runEval(experiment.id, 'control', 'write hello', 'hello');
    expect(result).toMatchObject({ score: 0.8, judgeReason: 'Complete and accurate' });
  });
});
