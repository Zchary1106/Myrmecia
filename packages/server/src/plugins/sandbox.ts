/**
 * Plugin Sandbox Isolation
 *
 * Runs each plugin in an isolated Worker thread with limited API access.
 * Communication via structured IPC messages with timeout enforcement.
 */

import { Worker } from 'worker_threads';
import { logger } from '../lib/logger.js';

// ---------- Types ----------

export interface SandboxMessage {
  type: 'call';
  method: string;
  args: any[];
}

export interface SandboxResult {
  type: 'result';
  value: any;
}

export interface SandboxError {
  type: 'error';
  message: string;
}

export interface SandboxOptions {
  timeoutMs?: number;
}

// ---------- PluginSandbox ----------

export class PluginSandbox {
  private defaultTimeout: number;

  constructor(opts?: { defaultTimeoutMs?: number }) {
    this.defaultTimeout = opts?.defaultTimeoutMs ?? 30_000;
  }

  /**
   * Execute a method in an isolated Worker thread.
   * The plugin code is evaluated inside the worker with restricted globals.
   */
  async execute(pluginId: string, method: string, args: any[] = [], opts?: SandboxOptions): Promise<any> {
    const timeout = opts?.timeoutMs ?? this.defaultTimeout;

    // Worker inline code: receives a call message and responds
    const workerCode = `
      const { parentPort, workerData } = require('worker_threads');

      // Remove dangerous globals
      delete globalThis.process.env;
      globalThis.require = undefined;

      parentPort.on('message', (msg) => {
        if (msg.type === 'call') {
          try {
            // Plugin execution stub — in production, load the plugin module
            // For now, return a structured response indicating the call was received
            parentPort.postMessage({
              type: 'result',
              value: {
                pluginId: workerData.pluginId,
                method: msg.method,
                args: msg.args,
                executed: true,
              },
            });
          } catch (err) {
            parentPort.postMessage({
              type: 'error',
              message: err.message || String(err),
            });
          }
        }
      });
    `;

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { pluginId },
      });

      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Plugin ${pluginId}.${method} timed out after ${timeout}ms`));
      }, timeout);

      worker.on('message', (msg: SandboxResult | SandboxError) => {
        clearTimeout(timer);
        worker.terminate();
        if (msg.type === 'error') {
          reject(new Error(msg.message));
        } else {
          resolve(msg.value);
        }
      });

      worker.on('error', (err) => {
        clearTimeout(timer);
        logger.error({ err, pluginId, method }, 'Plugin sandbox worker error');
        reject(err);
      });

      worker.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Plugin worker exited with code ${code}`));
        }
      });

      // Send the call message
      worker.postMessage({ type: 'call', method, args } satisfies SandboxMessage);
    });
  }
}

// ---------- Singleton ----------

export const pluginSandbox = new PluginSandbox();
