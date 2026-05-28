/**
 * Secret Management — secure credential storage abstraction
 *
 * Providers:
 * - EnvSecretProvider: reads from environment variables (development)
 * - VaultSecretProvider: reads from HashiCorp Vault HTTP API
 * - AWSSecretProvider: reads from AWS Secrets Manager
 *
 * Set SECRET_PROVIDER=env|vault|aws (default: env)
 * For Vault: VAULT_ADDR, VAULT_TOKEN
 * For AWS: AWS_REGION, AWS_SECRET_PREFIX
 */

import { logger } from '../lib/logger.js';

// ---------- Interface ----------

export interface SecretProvider {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  list(): Promise<string[]>;
  delete(key: string): Promise<void>;
  readonly name: string;
}

// ---------- Environment Provider ----------

class EnvSecretProvider implements SecretProvider {
  readonly name = 'env';
  private prefix: string;

  constructor(prefix = 'SECRET_') {
    this.prefix = prefix;
  }

  async get(key: string): Promise<string | undefined> {
    return process.env[`${this.prefix}${key}`] || process.env[key];
  }

  async set(key: string, value: string): Promise<void> {
    process.env[`${this.prefix}${key}`] = value;
  }

  async list(): Promise<string[]> {
    return Object.keys(process.env)
      .filter(k => k.startsWith(this.prefix))
      .map(k => k.slice(this.prefix.length));
  }

  async delete(key: string): Promise<void> {
    delete process.env[`${this.prefix}${key}`];
  }
}

// ---------- Vault Provider ----------

class VaultSecretProvider implements SecretProvider {
  readonly name = 'vault';
  private addr: string;
  private token: string;
  private mountPath: string;

  constructor() {
    this.addr = process.env.VAULT_ADDR || 'http://127.0.0.1:8200';
    this.token = process.env.VAULT_TOKEN || '';
    this.mountPath = process.env.VAULT_MOUNT_PATH || 'secret/data/agent-factory';
    if (!this.token) {
      logger.warn('VAULT_TOKEN not set — Vault provider may fail');
    }
  }

  private headers() {
    return { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' };
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.addr}/v1/${this.mountPath}/${key}`, {
        headers: this.headers(),
      });
      if (!res.ok) return undefined;
      const data = await res.json() as any;
      return data?.data?.data?.value;
    } catch (err: any) {
      logger.error({ key, err: err.message }, 'Vault get failed');
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await fetch(`${this.addr}/v1/${this.mountPath}/${key}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ data: { value } }),
      });
    } catch (err: any) {
      logger.error({ key, err: err.message }, 'Vault set failed');
      throw err;
    }
  }

  async list(): Promise<string[]> {
    try {
      const res = await fetch(`${this.addr}/v1/${this.mountPath}?list=true`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      return data?.data?.keys || [];
    } catch {
      return [];
    }
  }

  async delete(key: string): Promise<void> {
    await fetch(`${this.addr}/v1/${this.mountPath}/${key}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }
}

// ---------- AWS Secrets Manager Provider ----------

class AWSSecretProvider implements SecretProvider {
  readonly name = 'aws';
  private region: string;
  private prefix: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-east-1';
    this.prefix = process.env.AWS_SECRET_PREFIX || 'agent-factory/';
  }

  async get(key: string): Promise<string | undefined> {
    try {
      // Use AWS SDK v3 if available
      const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region: this.region });
      const result = await client.send(new GetSecretValueCommand({ SecretId: `${this.prefix}${key}` }));
      return result.SecretString;
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') return undefined;
      logger.error({ key, err: err.message }, 'AWS Secrets Manager get failed');
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      const { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } = require('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region: this.region });
      try {
        await client.send(new PutSecretValueCommand({ SecretId: `${this.prefix}${key}`, SecretString: value }));
      } catch {
        await client.send(new CreateSecretCommand({ Name: `${this.prefix}${key}`, SecretString: value }));
      }
    } catch (err: any) {
      logger.error({ key, err: err.message }, 'AWS Secrets Manager set failed');
      throw err;
    }
  }

  async list(): Promise<string[]> {
    try {
      const { SecretsManagerClient, ListSecretsCommand } = require('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region: this.region });
      const result = await client.send(new ListSecretsCommand({ Filters: [{ Key: 'name', Values: [this.prefix] }] }));
      return (result.SecretList || []).map((s: any) => s.Name?.replace(this.prefix, '') || '');
    } catch {
      return [];
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const { SecretsManagerClient, DeleteSecretCommand } = require('@aws-sdk/client-secrets-manager');
      const client = new SecretsManagerClient({ region: this.region });
      await client.send(new DeleteSecretCommand({ SecretId: `${this.prefix}${key}`, ForceDeleteWithoutRecovery: true }));
    } catch (err: any) {
      logger.error({ key, err: err.message }, 'AWS Secrets Manager delete failed');
    }
  }
}

// ---------- Factory ----------

let provider: SecretProvider | undefined;

export function getSecretProvider(): SecretProvider {
  if (!provider) {
    const mode = process.env.SECRET_PROVIDER || 'env';
    switch (mode) {
      case 'vault':
        provider = new VaultSecretProvider();
        logger.info('Using Vault secret provider');
        break;
      case 'aws':
        provider = new AWSSecretProvider();
        logger.info('Using AWS Secrets Manager provider');
        break;
      default:
        provider = new EnvSecretProvider();
        logger.info('Using environment variable secret provider');
    }
  }
  return provider;
}

/** Convenience: get a secret or throw */
export async function requireSecret(key: string): Promise<string> {
  const value = await getSecretProvider().get(key);
  if (!value) throw new Error(`Required secret "${key}" not found in ${getSecretProvider().name} provider`);
  return value;
}
