/**
 * Notification Channels — Multi-platform delivery
 *
 * Supports Slack, DingTalk, Feishu, WeCom, and Email (SMTP).
 * ChannelRouter dispatches events to configured channels per workspace.
 */

import { getDb } from '../db/database.js';
import { v4 as uuid } from 'uuid';
import { Router } from 'express';
import { logger } from '../lib/logger.js';
import net from 'node:net';
import tls from 'node:tls';

// ---------- Schema ----------

export const NOTIFICATION_CHANNELS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  events TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notification_channels_workspace ON notification_channels(workspace_id);
`;

// ---------- Types ----------

export interface NotificationMessage {
  title: string;
  body: string;
  event: string;
  metadata?: Record<string, any>;
}

export interface NotificationChannel {
  name: string;
  send(message: NotificationMessage): Promise<boolean>;
}

export interface ChannelConfig {
  id: string;
  workspaceId: string;
  type: string;
  config: Record<string, any>;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

// ---------- Channel Implementations ----------

export class SlackChannel implements NotificationChannel {
  name = 'slack';
  constructor(private webhookUrl: string) {}

  async send(message: NotificationMessage): Promise<boolean> {
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*${message.title}*\n${message.body}`,
        }),
      });
      return resp.ok;
    } catch (err) {
      logger.error({ err, channel: this.name }, 'Failed to send notification');
      return false;
    }
  }
}

export class DingTalkChannel implements NotificationChannel {
  name = 'dingtalk';
  constructor(private webhookUrl: string) {}

  async send(message: NotificationMessage): Promise<boolean> {
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: `${message.title}\n${message.body}` },
        }),
      });
      return resp.ok;
    } catch (err) {
      logger.error({ err, channel: this.name }, 'Failed to send notification');
      return false;
    }
  }
}

export class FeishuChannel implements NotificationChannel {
  name = 'feishu';
  constructor(private webhookUrl: string) {}

  async send(message: NotificationMessage): Promise<boolean> {
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'text',
          content: { text: `${message.title}\n${message.body}` },
        }),
      });
      return resp.ok;
    } catch (err) {
      logger.error({ err, channel: this.name }, 'Failed to send notification');
      return false;
    }
  }
}

export class WeComChannel implements NotificationChannel {
  name = 'wecom';
  constructor(private webhookUrl: string) {}

  async send(message: NotificationMessage): Promise<boolean> {
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: `${message.title}\n${message.body}` },
        }),
      });
      return resp.ok;
    } catch (err) {
      logger.error({ err, channel: this.name }, 'Failed to send notification');
      return false;
    }
  }
}

export class EmailChannel implements NotificationChannel {
  name = 'email';
  constructor(private smtpConfig: {
    host: string;
    port?: number;
    to: string | string[];
    from?: string;
    secure?: boolean;
    starttls?: boolean;
    username?: string;
    password?: string;
  }) {}

  async send(message: NotificationMessage): Promise<boolean> {
    const { host, to, from, username, password } = this.smtpConfig;
    if (!host || !to) {
      logger.warn({ channel: this.name }, 'SMTP notification skipped: host and recipient are required');
      return false;
    }
    const port = Number(this.smtpConfig.port || 587);
    try {
      await sendSmtpMessage({
        host, port, to, from: from || username || 'no-reply@localhost',
        username, password, secure: this.smtpConfig.secure ?? port === 465,
        starttls: this.smtpConfig.starttls ?? port === 587,
      }, message);
      return true;
    } catch (err) {
      logger.error({ err, channel: this.name, host, port }, 'Failed to send SMTP notification');
      return false;
    }
  }
}

interface SmtpConfig {
  host: string;
  port: number;
  to: string | string[];
  from: string;
  username?: string;
  password?: string;
  secure: boolean;
  starttls: boolean;
}

class SmtpSession {
  private buffer = '';
  private pending: Array<{ resolve: (value: string[]) => void; reject: (reason: Error) => void }> = [];

  constructor(private socket: net.Socket | tls.TLSSocket) {
    socket.setTimeout(30_000);
    socket.on('data', data => this.consume(data.toString('utf8')));
    socket.on('error', error => this.reject(error));
    socket.on('timeout', () => this.reject(new Error('SMTP connection timed out')));
    socket.on('close', () => this.reject(new Error('SMTP connection closed unexpectedly')));
  }

  private consume(data: string): void {
    this.buffer += data;
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\r\n')) >= 0) {
      lines.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 2);
      if (/^\d{3} /.test(lines[lines.length - 1])) {
        const request = this.pending.shift();
        if (request) request.resolve(lines.splice(0));
      }
    }
  }

  private reject(error: Error): void {
    while (this.pending.length) this.pending.shift()!.reject(error);
  }

  response(): Promise<string[]> {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async command(command: string, accepted: number[] = [250]): Promise<string[]> {
    const response = this.response();
    this.socket.write(`${command}\r\n`);
    const lines = await response;
    const status = Number(lines.at(-1)?.slice(0, 3));
    if (!accepted.includes(status)) throw new Error(`SMTP ${command.split(' ')[0]} failed: ${lines.join(' | ')}`);
    return lines;
  }

  async data(content: string): Promise<void> {
    await this.command('DATA', [354]);
    const response = this.response();
    this.socket.write(`${content.replace(/^\./gm, '..')}\r\n.\r\n`);
    const lines = await response;
    if (Number(lines.at(-1)?.slice(0, 3)) !== 250) throw new Error(`SMTP DATA failed: ${lines.join(' | ')}`);
  }

  async upgradeToTls(host: string): Promise<SmtpSession> {
    // STARTTLS upgrades this exact TCP connection; opening a second connection
    // would discard the SMTP protocol state and can leak a plaintext attempt.
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('timeout');
    this.socket.removeAllListeners('close');
    const secureSocket = tls.connect({ socket: this.socket, servername: host });
    await new Promise<void>((resolve, reject) => { secureSocket.once('secureConnect', resolve); secureSocket.once('error', reject); });
    return new SmtpSession(secureSocket);
  }

  end(): void { this.socket.end(); }
}

async function connectSmtp(config: SmtpConfig): Promise<SmtpSession> {
  const socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.createConnection({ host: config.host, port: config.port });
  await new Promise<void>((resolve, reject) => {
    socket.once(config.secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  return new SmtpSession(socket);
}

export async function sendSmtpMessage(config: SmtpConfig, message: NotificationMessage): Promise<void> {
  let session = await connectSmtp(config);
  try {
    await session.response(); // server greeting
    let capabilities = await session.command('EHLO myrmecia.local');
    const supportsStarttls = capabilities.some(line => /\bSTARTTLS\b/i.test(line));
    if (!config.secure && config.starttls) {
      if (!supportsStarttls) throw new Error('SMTP server does not advertise STARTTLS');
      await session.command('STARTTLS', [220]);
      session = await session.upgradeToTls(config.host);
      capabilities = await session.command('EHLO myrmecia.local');
    }
    if (config.username) {
      if (!config.secure && !config.starttls) throw new Error('SMTP authentication requires TLS; enable secure or STARTTLS');
      const credentials = Buffer.from(`\0${config.username}\0${config.password || ''}`).toString('base64');
      await session.command(`AUTH PLAIN ${credentials}`, [235]);
    }
    await session.command(`MAIL FROM:<${config.from}>`);
    for (const recipient of (Array.isArray(config.to) ? config.to : [config.to])) {
      await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    const body = [`From: ${config.from}`, `To: ${Array.isArray(config.to) ? config.to.join(', ') : config.to}`, `Subject: ${message.title}`, 'Content-Type: text/plain; charset=utf-8', '', message.body].join('\r\n');
    await session.data(body);
    await session.command('QUIT', [221]);
  } finally {
    session.end();
  }
}

// ---------- Channel Factory ----------

function createChannel(type: string, config: Record<string, any>): NotificationChannel | null {
  switch (type) {
    case 'slack': return new SlackChannel(config.webhookUrl);
    case 'dingtalk': return new DingTalkChannel(config.webhookUrl);
    case 'feishu': return new FeishuChannel(config.webhookUrl);
    case 'wecom': return new WeComChannel(config.webhookUrl);
    case 'email': return new EmailChannel(config as any);
    default: return null;
  }
}

// ---------- Helpers ----------

function rowToChannelConfig(row: any): ChannelConfig {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    config: JSON.parse(row.config || '{}'),
    events: JSON.parse(row.events || '[]'),
    enabled: !!row.enabled,
    createdAt: row.created_at,
  };
}

// ---------- ChannelRouter ----------

export class ChannelRouter {
  initSchema(): void {
    const db = getDb();
    db.exec(NOTIFICATION_CHANNELS_SCHEMA);
  }

  async route(event: string, message: NotificationMessage, workspaceId: string): Promise<void> {
    this.initSchema();
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM notification_channels WHERE workspace_id = ? AND enabled = 1',
      workspaceId,
    );

    for (const row of rows) {
      const cfg = rowToChannelConfig(row);
      if (cfg.events.length > 0 && !cfg.events.includes(event)) continue;

      const channel = createChannel(cfg.type, cfg.config);
      if (!channel) {
        logger.warn({ type: cfg.type }, 'Unknown notification channel type');
        continue;
      }

      try {
        await channel.send(message);
      } catch (err) {
        logger.error({ err, channelId: cfg.id }, 'Failed to route notification');
      }
    }
  }

  addChannel(opts: {
    workspaceId: string;
    type: string;
    config: Record<string, any>;
    events?: string[];
  }): ChannelConfig {
    this.initSchema();
    const db = getDb();
    const id = uuid();
    db.run(
      `INSERT INTO notification_channels (id, workspace_id, type, config, events)
       VALUES (?, ?, ?, ?, ?)`,
      id, opts.workspaceId, opts.type,
      JSON.stringify(opts.config), JSON.stringify(opts.events ?? []),
    );
    const row = db.get('SELECT * FROM notification_channels WHERE id = ?', id);
    return rowToChannelConfig(row);
  }

  updateChannel(id: string, workspaceId: string, updates: Partial<{
    config: Record<string, any>;
    events: string[];
    enabled: boolean;
  }>): ChannelConfig | null {
    this.initSchema();
    const db = getDb();
    const existing = db.get(
      'SELECT * FROM notification_channels WHERE id = ? AND workspace_id = ?',
      id, workspaceId,
    );
    if (!existing) return null;

    const sets: string[] = [];
    const params: any[] = [];
    if (updates.config !== undefined) { sets.push('config = ?'); params.push(JSON.stringify(updates.config)); }
    if (updates.events !== undefined) { sets.push('events = ?'); params.push(JSON.stringify(updates.events)); }
    if (updates.enabled !== undefined) { sets.push('enabled = ?'); params.push(updates.enabled ? 1 : 0); }

    if (sets.length > 0) {
      params.push(id, workspaceId);
      db.run(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...params);
    }

    const row = db.get('SELECT * FROM notification_channels WHERE id = ?', id);
    return rowToChannelConfig(row);
  }

  removeChannel(id: string, workspaceId: string): boolean {
    this.initSchema();
    const db = getDb();
    const result = db.run(
      'DELETE FROM notification_channels WHERE id = ? AND workspace_id = ?',
      id, workspaceId,
    );
    return result.changes > 0;
  }

  listChannels(workspaceId: string): ChannelConfig[] {
    this.initSchema();
    const db = getDb();
    const rows = db.all(
      'SELECT * FROM notification_channels WHERE workspace_id = ? ORDER BY created_at DESC',
      workspaceId,
    );
    return rows.map(rowToChannelConfig);
  }
}

export const channelRouter = new ChannelRouter();

// ---------- Routes ----------

export function createChannelRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || (req.query.workspaceId as string) || 'default';
      const channels = channelRouter.listChannels(workspaceId);
      res.json(channels);
    } catch (err: any) {
      logger.error({ err }, 'Failed to list channels');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || req.body.workspaceId || 'default';
      const { type, config, events } = req.body;
      if (!type || !config) {
        res.status(400).json({ error: 'type and config are required' });
        return;
      }
      const channel = channelRouter.addChannel({ workspaceId, type, config, events });
      res.status(201).json(channel);
    } catch (err: any) {
      logger.error({ err }, 'Failed to add channel');
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || 'default';
      const updated = channelRouter.updateChannel(req.params.id, workspaceId, req.body);
      if (!updated) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }
      res.json(updated);
    } catch (err: any) {
      logger.error({ err }, 'Failed to update channel');
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const workspaceId = (req as any).workspaceId || 'default';
      const removed = channelRouter.removeChannel(req.params.id, workspaceId);
      if (!removed) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err }, 'Failed to remove channel');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
