import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
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

  it('delivers SMTP notifications through a configured SMTP server', async () => {
    let delivered = '';
    const server = net.createServer(socket => {
      let buffer = '';
      let acceptingData = false;
      socket.write('220 test SMTP\r\n');
      socket.on('data', chunk => {
        buffer += chunk.toString();
        if (acceptingData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end >= 0) { delivered = buffer.slice(0, end); buffer = buffer.slice(end + 5); acceptingData = false; socket.write('250 accepted\r\n'); }
          return;
        }
        let lineEnd: number;
        while ((lineEnd = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, lineEnd); buffer = buffer.slice(lineEnd + 2);
          if (line === 'DATA') { acceptingData = true; socket.write('354 send body\r\n'); }
          else if (line === 'QUIT') socket.write('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as net.AddressInfo;
    const channel = new EmailChannel({ host: '127.0.0.1', port: address.port, secure: false, starttls: false, to: 'ops@example.test' });
    await expect(channel.send({ title: 'Task finished', body: 'Done', event: 'task.done' })).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(delivered).toContain('Subject: Task finished');
    expect(delivered).toContain('Done');
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
