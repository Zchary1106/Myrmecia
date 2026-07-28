import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import type { Readable } from 'node:stream';

type CheckStatus = 'pass' | 'warn' | 'fail';
type StartupPhase = 'starting' | 'ready' | 'failed' | 'configuration';
type DesktopModelProvider = 'openai-compatible' | 'deepseek' | 'copilot';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface StartupState {
  phase: StartupPhase;
  message: string;
  logPath?: string;
}

interface StoredRuntimeConfiguration {
  provider?: DesktopModelProvider;
  baseUrl?: string;
  model?: string;
  encryptedApiKey?: string;
}

interface RuntimeConfigurationSummary {
  provider: DesktopModelProvider;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  secureStorageAvailable: boolean;
  recoveryMessage?: string;
}

interface RuntimeConfigurationInput {
  provider?: DesktopModelProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

interface LoadedRuntimeConfiguration {
  configuration: StoredRuntimeConfiguration;
  recoveryMessage?: string;
}

interface NodeRuntime {
  executable: string;
  version: string;
  major: number;
  moduleVersion: string;
  platform: string;
  arch: string;
}

interface ServerRuntimeRequirements {
  nodeVersion: string;
  nodeModuleVersion: string;
  platform: string;
  arch: string;
}

interface ResourceLayout {
  serverEntry: string;
  runtimeRequirementsPath?: string;
  resourceRoot: string;
  dashboardDir: string;
  agentsDir: string;
  templatesDir: string;
  pythonRuntimeDir: string;
  splashPath: string;
  preloadPath: string;
}

const START_PORT = 3000;
const PORT_ATTEMPTS = 20;
const HEALTH_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const RUNTIME_CONFIGURATION_FILE = 'runtime-config.json';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const COPILOT_DEFAULT_MODEL = 'auto';
const moduleDir = dirname(fileURLToPath(import.meta.url));
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

const configuredUserDataDirectory = process.env.MYRMECIA_DESKTOP_USER_DATA?.trim();
if (configuredUserDataDirectory) {
  app.setPath('userData', resolve(configuredUserDataDirectory));
}

let splashWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let serverChild: ServerChild | null = null;
let serverLog: WriteStream | null = null;
let serverOrigin: string | null = null;
let stoppingServer = false;
let quitAllowed = false;
let shutdownPromise: Promise<void> | null = null;
let launchPromise: Promise<void> | null = null;
let recentServerOutput = '';
let startupState: StartupState = { phase: 'starting', message: '正在准备本地服务…' };

function getResourceLayout(): ResourceLayout {
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      serverEntry: join(resources, 'server', 'dist', 'index.js'),
      runtimeRequirementsPath: join(resources, 'server', 'desktop-runtime.json'),
      resourceRoot: resources,
      dashboardDir: join(resources, 'dashboard'),
      agentsDir: join(resources, 'agents'),
      templatesDir: join(resources, 'templates'),
      pythonRuntimeDir: join(resources, 'python-runtime'),
      splashPath: join(resources, 'desktop', 'splash.html'),
      preloadPath: join(app.getAppPath(), 'dist', 'preload.cjs'),
    };
  }

  const desktopRoot = resolve(moduleDir, '..');
  const repositoryRoot = resolve(desktopRoot, '..', '..');
  return {
    serverEntry: join(repositoryRoot, 'packages', 'server', 'dist', 'index.js'),
    resourceRoot: repositoryRoot,
    dashboardDir: join(repositoryRoot, 'packages', 'dashboard', 'dist'),
    agentsDir: join(repositoryRoot, 'agents'),
    templatesDir: join(repositoryRoot, 'templates'),
    pythonRuntimeDir: join(repositoryRoot, 'packages', 'python-runtime'),
    splashPath: join(desktopRoot, 'src', 'splash', 'splash.html'),
    preloadPath: join(desktopRoot, 'dist', 'preload.cjs'),
  };
}

function publishStartupState(): void {
  if (!splashWindow || splashWindow.isDestroyed() || splashWindow.webContents.isDestroyed()) return;
  splashWindow.webContents.send('desktop:startup-state-changed', startupState);
}

function setStartupState(phase: StartupState['phase'], message: string): void {
  startupState = { phase, message, logPath: serverLog?.path.toString() };
  publishStartupState();
}

function runtimeConfigurationPath(): string {
  return join(app.getPath('userData'), RUNTIME_CONFIGURATION_FILE);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, maximumLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximumLength) throw new Error(`${field} 超过最大长度。`);
  return normalized;
}

function normalizeBaseUrl(value: unknown): string | undefined {
  const baseUrl = optionalString(value, '模型 Base URL', 2_048);
  if (!baseUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('模型 Base URL 不是有效 URL。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('模型 Base URL 仅支持 HTTP 或 HTTPS。');
  }
  return baseUrl.replace(/\/+$/, '');
}

function normalizeProvider(value: unknown): DesktopModelProvider | undefined {
  const provider = optionalString(value, '模型 Provider', 64);
  if (!provider) return undefined;
  if (provider === 'openai-compatible' || provider === 'deepseek' || provider === 'copilot') {
    return provider;
  }
  throw new Error('模型 Provider 必须是 OpenAI-compatible、DeepSeek 或 GitHub Copilot。');
}

function configuredProvider(configuration: StoredRuntimeConfiguration): DesktopModelProvider {
  return configuration.provider
    ?? normalizeProvider(process.env.MYRMECIA_MODEL_PROVIDER)
    ?? 'openai-compatible';
}

function parseRuntimeConfigurationInput(value: unknown): RuntimeConfigurationInput {
  if (!isRecord(value)) throw new Error('模型配置格式无效。');
  return {
    provider: normalizeProvider(value.provider),
    baseUrl: normalizeBaseUrl(value.baseUrl),
    model: optionalString(value.model, '模型名称', 256),
    apiKey: optionalString(value.apiKey, 'API Key', 16_384),
  };
}

async function readStoredRuntimeConfiguration(): Promise<StoredRuntimeConfiguration> {
  let raw: string;
  try {
    raw = await readFile(runtimeConfigurationPath(), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return {};
    throw new Error(`无法读取桌面配置：${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('桌面配置文件已损坏；请删除 runtime-config.json 后重试。');
  }
  if (!isRecord(parsed)) throw new Error('桌面配置文件格式无效。');

  const baseUrl = normalizeBaseUrl(parsed.baseUrl);
  const model = optionalString(parsed.model, '模型名称', 256);
  const encryptedApiKey = optionalString(parsed.encryptedApiKey, '加密 API Key', 65_536);
  const provider = normalizeProvider(parsed.provider);
  return { provider, baseUrl, model, encryptedApiKey };
}

async function loadStoredRuntimeConfiguration(): Promise<LoadedRuntimeConfiguration> {
  try {
    return { configuration: await readStoredRuntimeConfiguration() };
  } catch (error) {
    return {
      configuration: {},
      recoveryMessage: error instanceof Error ? error.message : '无法读取已保存的模型配置。',
    };
  }
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

function decryptApiKey(configuration: StoredRuntimeConfiguration): string | undefined {
  if (!configuration.encryptedApiKey) return undefined;
  if (!secureStorageAvailable()) {
    throw new Error('系统凭据库不可用，无法解密已保存的 API Key。');
  }
  try {
    return safeStorage.decryptString(Buffer.from(configuration.encryptedApiKey, 'base64'));
  } catch {
    throw new Error('无法解密已保存的 API Key。请重新配置模型凭据。');
  }
}

async function writeStoredRuntimeConfiguration(configuration: StoredRuntimeConfiguration): Promise<void> {
  const destination = runtimeConfigurationPath();
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
}

async function runtimeConfigurationSummary(): Promise<RuntimeConfigurationSummary> {
  const loaded = await loadStoredRuntimeConfiguration();
  const { configuration } = loaded;
  const provider = configuredProvider(configuration);
  let recoveryMessage = loaded.recoveryMessage;
  let apiKey: string | undefined;
  if (!recoveryMessage) {
    try {
      apiKey = decryptApiKey(configuration);
    } catch (error) {
      recoveryMessage = error instanceof Error ? error.message : '无法读取已保存的 API Key。';
    }
  }
  return {
    provider,
    baseUrl: provider === 'copilot'
      ? ''
      : configuration.baseUrl
        ?? process.env.MYRMECIA_BASE_URL
        ?? process.env.AGENT_FACTORY_BASE_URL
        ?? (provider === 'deepseek' ? DEEPSEEK_BASE_URL : ''),
    model: configuration.model
      ?? process.env.MYRMECIA_MODEL
      ?? process.env.AGENT_FACTORY_MODEL
      ?? (provider === 'deepseek'
        ? DEEPSEEK_DEFAULT_MODEL
        : provider === 'copilot'
          ? COPILOT_DEFAULT_MODEL
          : ''),
    apiKeyConfigured: provider === 'copilot' || Boolean(
      apiKey
        || process.env.MYRMECIA_API_KEY
        || process.env.AGENT_FACTORY_API_KEY
        || process.env.ANTHROPIC_API_KEY
        || process.env.OPENAI_API_KEY,
    ),
    secureStorageAvailable: secureStorageAvailable(),
    ...(recoveryMessage ? { recoveryMessage } : {}),
  };
}

async function saveRuntimeConfiguration(value: unknown): Promise<RuntimeConfigurationSummary> {
  const input = parseRuntimeConfigurationInput(value);
  const loaded = await loadStoredRuntimeConfiguration();
  const current = loaded.configuration;
  const provider = input.provider ?? current.provider ?? 'openai-compatible';
  if (provider === 'copilot' && input.apiKey) {
    throw new Error('GitHub Copilot 使用本机 Copilot CLI / SDK 登录凭据，不接受 API Key。');
  }
  const providerChanged = provider !== current.provider;
  let encryptedApiKey = loaded.recoveryMessage || providerChanged ? undefined : current.encryptedApiKey;
  if (input.apiKey) {
    if (!secureStorageAvailable()) {
      throw new Error('系统凭据库不可用，无法安全保存 API Key。请通过环境变量提供凭据。');
    }
    encryptedApiKey = safeStorage.encryptString(input.apiKey).toString('base64');
  }
  const baseUrl = input.baseUrl ?? (providerChanged ? undefined : current.baseUrl);
  const model = provider === 'copilot'
    ? undefined
    : input.model ?? (providerChanged ? undefined : current.model);
  await writeStoredRuntimeConfiguration({
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(encryptedApiKey ? { encryptedApiKey } : {}),
  });
  return runtimeConfigurationSummary();
}

async function runtimeConfigurationEnvironment(): Promise<Record<string, string>> {
  const loaded = await loadStoredRuntimeConfiguration();
  const { configuration } = loaded;
  const provider = configuredProvider(configuration);
  let apiKey: string | undefined;
  if (!loaded.recoveryMessage) {
    try {
      apiKey = decryptApiKey(configuration);
    } catch {
      // A configuration error is surfaced by the splash before startup. If an
      // environment API key is available, the child can still start without it.
    }
  }
  return {
    MYRMECIA_MODEL_PROVIDER: provider,
    ...(provider === 'deepseek'
      ? {
        MYRMECIA_BASE_URL: configuration.baseUrl || DEEPSEEK_BASE_URL,
        MYRMECIA_MODEL: configuration.model || DEEPSEEK_DEFAULT_MODEL,
      }
      : provider === 'copilot'
        ? { MYRMECIA_MODEL: configuration.model || COPILOT_DEFAULT_MODEL }
      : {
        ...(configuration.baseUrl ? { MYRMECIA_BASE_URL: configuration.baseUrl } : {}),
        ...(configuration.model ? { MYRMECIA_MODEL: configuration.model } : {}),
      }),
    ...(provider !== 'copilot' && apiKey ? { MYRMECIA_API_KEY: apiKey } : {}),
  };
}

function createSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) return;
  const layout = getResourceLayout();
  splashWindow = new BrowserWindow({
    width: 620,
    height: 780,
    resizable: false,
    maximizable: false,
    show: false,
    title: 'Myrmecia',
    webPreferences: {
      preload: layout.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.removeMenu();
  configureWindowSecurity(splashWindow, false);
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.webContents.on('did-finish-load', publishStartupState);
  void splashWindow.loadFile(layout.splashPath);
}

function createDashboardWindow(origin: string): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    void dashboardWindow.loadURL(origin);
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Myrmecia',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dashboardWindow.removeMenu();
  configureWindowSecurity(dashboardWindow, true);
  dashboardWindow.once('ready-to-show', () => dashboardWindow?.show());
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
  void dashboardWindow.loadURL(origin);
}

function configureWindowSecurity(window: BrowserWindow, allowsLocalServer: boolean): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, allowsLocalServer)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

function openExternalUrl(url: string): void {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      console.warn(`Blocked unsupported external navigation protocol: ${target.protocol}`);
      return;
    }
    void shell.openExternal(target.toString()).catch(error => {
      console.warn(`Unable to open external URL: ${error.message}`);
    });
  } catch {
    console.warn('Blocked invalid external navigation URL.');
  }
}

function isAllowedNavigation(url: string, allowsLocalServer: boolean): boolean {
  try {
    const target = new URL(url);
    if (!allowsLocalServer) return target.protocol === 'file:';
    return target.origin === serverOrigin;
  } catch {
    return false;
  }
}

function executableOnPath(command: string): string | undefined {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookup, [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).find(Boolean)?.trim();
}

function commonNodeExecutablePaths(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Volta', 'bin', 'node.exe'),
    ].filter((path): path is string => Boolean(path));
  }

  const home = process.env.HOME;
  return [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    home && join(home, '.volta', 'bin', 'node'),
    home && join(home, '.asdf', 'shims', 'node'),
  ].filter((path): path is string => Boolean(path));
}

function commonPythonExecutablePaths(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Python313', 'python.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Python312', 'python.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Python311', 'python.exe'),
    ].filter((path): path is string => Boolean(path));
  }

  return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
}

function resolveExecutable(command: string, fallbacks: string[]): string | undefined {
  return executableOnPath(command) ?? fallbacks.find(existsSync);
}

function inspectNodeRuntime(executable: string): NodeRuntime {
  const result = spawnSync(
    executable,
    ['-p', 'JSON.stringify({ version: process.versions.node, moduleVersion: process.versions.modules, platform: process.platform, arch: process.arch })'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error('无法运行指定的 Node.js 可执行文件。');
  }

  let details: unknown;
  try {
    details = JSON.parse(result.stdout);
  } catch {
    throw new Error('无法读取 Node.js 运行时信息。');
  }
  if (
    !isRecord(details)
    || typeof details.version !== 'string'
    || typeof details.moduleVersion !== 'string'
    || typeof details.platform !== 'string'
    || typeof details.arch !== 'string'
  ) {
    throw new Error('Node.js 运行时信息不完整。');
  }

  const major = Number.parseInt(details.version.split('.')[0], 10);
  if (!Number.isInteger(major)) {
    throw new Error('无法识别 Node.js 版本。');
  }
  return {
    executable,
    version: details.version,
    major,
    moduleVersion: details.moduleVersion,
    platform: details.platform,
    arch: details.arch,
  };
}

async function readServerRuntimeRequirements(layout: ResourceLayout): Promise<ServerRuntimeRequirements | undefined> {
  if (!layout.runtimeRequirementsPath || !existsSync(layout.runtimeRequirementsPath)) return undefined;

  let raw: string;
  try {
    raw = await readFile(layout.runtimeRequirementsPath, 'utf8');
  } catch {
    throw new Error('无法读取桌面包的 Node.js 兼容性信息。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('桌面包的 Node.js 兼容性信息已损坏。');
  }
  if (
    !isRecord(parsed)
    || typeof parsed.nodeVersion !== 'string'
    || typeof parsed.nodeModuleVersion !== 'string'
    || typeof parsed.platform !== 'string'
    || typeof parsed.arch !== 'string'
  ) {
    throw new Error('桌面包的 Node.js 兼容性信息无效。');
  }
  return {
    nodeVersion: parsed.nodeVersion,
    nodeModuleVersion: parsed.nodeModuleVersion,
    platform: parsed.platform,
    arch: parsed.arch,
  };
}

function assertCompatibleNodeRuntime(runtime: NodeRuntime, requirements?: ServerRuntimeRequirements): void {
  if (runtime.major < 20) {
    throw new Error('Myrmecia Desktop 需要 Node.js 20 或更高版本。');
  }
  if (!requirements) return;

  if (
    runtime.moduleVersion !== requirements.nodeModuleVersion
    || runtime.platform !== requirements.platform
    || runtime.arch !== requirements.arch
  ) {
    throw new Error(
      `此桌面包中的原生依赖需要 Node.js ${requirements.nodeVersion} `
      + `（ABI ${requirements.nodeModuleVersion}，${requirements.platform}/${requirements.arch}）；`
      + `当前为 Node.js ${runtime.version}（ABI ${runtime.moduleVersion}，${runtime.platform}/${runtime.arch}）。`,
    );
  }
}

function assertCopilotCompatibleNodeRuntime(runtime: NodeRuntime): void {
  const [majorText, minorText] = runtime.version.split('.');
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  const supported = (major === 20 && minor >= 19)
    || (major === 22 && minor >= 12)
    || major >= 23;
  if (!supported) {
    throw new Error(
      `GitHub Copilot SDK 需要 Node.js 20.19+ 或 22.12+；当前为 Node.js ${runtime.version}。`,
    );
  }
}

function resolveNodeExecutable(): NodeRuntime {
  const configured = process.env.MYRMECIA_NODE_PATH?.trim();
  let executable: string;
  if (configured) {
    if (isAbsolute(configured) && !existsSync(configured)) {
      throw new Error('MYRMECIA_NODE_PATH 指向的 Node.js 可执行文件不存在。');
    }
    executable = configured;
  } else {
    const discovered = resolveExecutable(
      process.platform === 'win32' ? 'node.exe' : 'node',
      commonNodeExecutablePaths(),
    );
    if (!discovered) {
      throw new Error('未在 PATH 中找到 Node.js。请安装 Node.js 20+，或设置 MYRMECIA_NODE_PATH。');
    }
    executable = discovered;
  }

  const runtime = inspectNodeRuntime(executable);
  assertCompatibleNodeRuntime(runtime);
  return runtime;
}

interface PythonInvocation {
  command: string;
  argsPrefix: string[];
}

function resolvePythonInvocation(): PythonInvocation | undefined {
  const configured = process.env.MYRMECIA_PYTHON_PATH?.trim();
  if (configured) return { command: configured, argsPrefix: [] };

  const candidates: PythonInvocation[] = process.platform === 'win32'
    ? [
      { command: 'py', argsPrefix: ['-3'] },
      { command: 'python', argsPrefix: [] },
      { command: 'python3', argsPrefix: [] },
    ]
    : [{ command: 'python3', argsPrefix: [] }];

  for (const candidate of candidates) {
    const executable = resolveExecutable(candidate.command, commonPythonExecutablePaths());
    if (!executable) continue;
    const result = spawnSync(executable, [...candidate.argsPrefix, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0) {
      return { ...candidate, command: executable };
    }
  }
  return undefined;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolveAvailable => {
    const probe = createServer();
    probe.once('error', () => resolveAvailable(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(error => resolveAvailable(!error));
    });
  });
}

function healthCheck(origin: string, healthToken: string): Promise<boolean> {
  return new Promise(resolveHealth => {
    const probe = request(`${origin}/health`, {
      method: 'GET',
      timeout: 1_500,
      headers: { 'x-myrmecia-health-token': healthToken },
    }, response => {
      response.resume();
      resolveHealth(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    probe.once('timeout', () => {
      probe.destroy();
      resolveHealth(false);
    });
    probe.once('error', () => resolveHealth(false));
    probe.end();
  });
}

async function waitForHealth(
  origin: string,
  child: ServerChild,
  healthToken: string,
): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) return 'exited';
    if (await healthCheck(origin, healthToken)) return 'ready';
    await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
  }
  return 'timeout';
}

async function openServerLog(): Promise<void> {
  if (serverLog) return;
  const logDirectory = join(app.getPath('userData'), 'logs');
  await mkdir(logDirectory, { recursive: true });
  serverLog = createWriteStream(join(logDirectory, 'server.log'), { flags: 'a', mode: 0o600 });
}

function writeServerLog(source: 'stdout' | 'stderr', data: Buffer): void {
  const text = data.toString();
  recentServerOutput = `${recentServerOutput}${text}`.slice(-8_000);
  serverLog?.write(`[${new Date().toISOString()}] ${source}: ${text}`);
}

async function stopServer(): Promise<void> {
  const child = serverChild;
  serverChild = null;
  serverOrigin = null;
  if (!child || child.exitCode !== null) return;

  stoppingServer = true;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>(resolveTimeout => setTimeout(() => resolveTimeout(true), SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  stoppingServer = false;
}

function validateLayout(layout: ResourceLayout): void {
  const requiredPaths = [
    layout.serverEntry,
    layout.dashboardDir,
    layout.agentsDir,
    layout.templatesDir,
    ...(app.isPackaged && layout.runtimeRequirementsPath ? [layout.runtimeRequirementsPath] : []),
  ];
  const missing = requiredPaths
    .filter(path => !existsSync(path));
  if (missing.length > 0) {
    throw new Error('桌面运行资源不完整。开发模式请先构建 server 与 dashboard；安装包请重新打包。');
  }
}

async function startServer(): Promise<void> {
  await stopServer();
  const layout = getResourceLayout();
  validateLayout(layout);
  const nodeRuntime = resolveNodeExecutable();
  const runtimeRequirements = await readServerRuntimeRequirements(layout);
  assertCompatibleNodeRuntime(nodeRuntime, runtimeRequirements);
  const runtimeEnvironment = await runtimeConfigurationEnvironment();
  if (runtimeEnvironment.MYRMECIA_MODEL_PROVIDER === 'copilot') {
    assertCopilotCompatibleNodeRuntime(nodeRuntime);
  }
  await openServerLog();
  const serverWorkingDirectory = app.getPath('userData');
  await mkdir(serverWorkingDirectory, { recursive: true });
  setStartupState('starting', '正在启动本地服务…');

  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const port = START_PORT + offset;
    if (!await isPortAvailable(port)) continue;

    const origin = `http://127.0.0.1:${port}`;
    const healthToken = randomBytes(32).toString('base64url');
    recentServerOutput = '';
    const child = spawn(nodeRuntime.executable, [layout.serverEntry], {
      cwd: serverWorkingDirectory,
      env: {
        ...process.env,
        ...runtimeEnvironment,
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH: join(app.getPath('userData'), 'myrmecia.db'),
        SERVE_DASHBOARD_DIR: layout.dashboardDir,
        MYRMECIA_RESOURCE_ROOT: layout.resourceRoot,
        MYRMECIA_WORKSPACE_ROOT: serverWorkingDirectory,
        MYRMECIA_PYTHON_RUNTIME_DIR: layout.pythonRuntimeDir,
        MYRMECIA_DESKTOP_HEALTH_TOKEN: healthToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    serverChild = child;
    child.stdout.on('data', data => writeServerLog('stdout', data));
    child.stderr.on('data', data => writeServerLog('stderr', data));
    child.once('error', error => writeServerLog('stderr', Buffer.from(`Unable to start server: ${error.message}\n`)));
    child.once('exit', (code, signal) => {
      if (serverChild === child) serverChild = null;
      if (!stoppingServer && !quitAllowed) {
        setStartupState('failed', `本地服务意外退出（${signal ?? `退出码 ${code ?? '未知'}`}）。`);
        dashboardWindow?.hide();
        showSplashForFailure();
      }
    });

    const healthState = await waitForHealth(origin, child, healthToken);
    if (healthState === 'ready') {
      serverOrigin = origin;
      setStartupState('ready', '本地服务已就绪。');
      return;
    }

    const addressInUse = /EADDRINUSE/i.test(recentServerOutput);
    await stopServer();
    if (healthState === 'exited' && addressInUse) continue;
    if (healthState === 'timeout') {
      throw new Error('本地服务在等待时间内未通过健康检查。请查看日志后重试。');
    }
    throw new Error('本地服务未能启动。请查看日志后重试。');
  }
  throw new Error(`端口 ${START_PORT}–${START_PORT + PORT_ATTEMPTS - 1} 都不可用，未终止任何现有进程。`);
}

function showSplashForFailure(): void {
  if (!splashWindow || splashWindow.isDestroyed()) createSplashWindow();
  splashWindow?.show();
  splashWindow?.focus();
}

function launchDashboard(): Promise<void> {
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    try {
      setStartupState('starting', '正在检查并启动本地服务…');
      showSplashForFailure();
      await startServer();
      if (!serverOrigin) throw new Error('本地服务没有可用地址。');
      createDashboardWindow(serverOrigin);
      splashWindow?.close();
      splashWindow = null;
    } catch (error) {
      setStartupState('failed', error instanceof Error ? error.message : '本地服务启动失败。');
      showSplashForFailure();
    } finally {
      launchPromise = null;
    }
  })();
  return launchPromise;
}

async function beginStartup(): Promise<void> {
  try {
    const configuration = await runtimeConfigurationSummary();
    setStartupState(
      'configuration',
      configuration.recoveryMessage
        ? `${configuration.recoveryMessage} 请重新选择模型 Provider。`
        : '请选择模型 Provider 后启动本地服务。',
    );
    showSplashForFailure();
  } catch (error) {
    setStartupState('failed', error instanceof Error ? error.message : '无法读取桌面配置。');
    showSplashForFailure();
  }
}

async function runCommand(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolveCommand => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    child.once('error', () => resolveCommand({ ok: false, output: '' }));
    child.once('exit', code => resolveCommand({ ok: code === 0, output: output.trim() }));
  });
}

async function runDoctor(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  try {
    const nodeRuntime = resolveNodeExecutable();
    const requirements = await readServerRuntimeRequirements(getResourceLayout());
    assertCompatibleNodeRuntime(nodeRuntime, requirements);
    const configuration = await runtimeConfigurationSummary();
    if (configuration.provider === 'copilot') {
      assertCopilotCompatibleNodeRuntime(nodeRuntime);
    }
    checks.push({
      name: 'Node.js',
      status: 'pass',
      detail: `v${nodeRuntime.version}（ABI ${nodeRuntime.moduleVersion}，${nodeRuntime.platform}/${nodeRuntime.arch}）`,
    });
  } catch (error) {
    checks.push({ name: 'Node.js', status: 'fail', detail: error instanceof Error ? error.message : '未找到 Node.js。' });
  }

  const python = resolvePythonInvocation();
  if (!python) {
    checks.push({ name: 'python3', status: 'warn', detail: '未找到（可选；仅 Python agent runtime 需要）。' });
    checks.push({ name: 'Python 包', status: 'warn', detail: '未检查：python3 不可用。' });
    return checks;
  }

  const pythonVersion = await runCommand(python.command, [...python.argsPrefix, '--version']);
  checks.push({
    name: 'python3',
    status: pythonVersion.ok ? 'pass' : 'warn',
    detail: pythonVersion.ok ? pythonVersion.output : '无法运行（可选）。',
  });
  const packages = await runCommand(python.command, [
    ...python.argsPrefix,
    '-c',
    'import crewai, litellm, yaml; print("crewai, litellm, yaml: ready")',
  ]);
  checks.push({
    name: 'Python 包',
    status: packages.ok ? 'pass' : 'warn',
    detail: packages.ok ? packages.output : '缺少 crewai、litellm 或 PyYAML（不影响仪表板启动）。',
  });
  return checks;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    createSplashWindow();
    ipcMain.handle('desktop:get-startup-state', () => startupState);
    ipcMain.handle('desktop:run-doctor', () => runDoctor());
    ipcMain.handle('desktop:get-runtime-config', () => runtimeConfigurationSummary());
    ipcMain.handle('desktop:save-runtime-config', (_event, configuration) => saveRuntimeConfiguration(configuration));
    ipcMain.on('desktop:retry-startup', () => {
      void launchDashboard();
    });
    ipcMain.on('desktop:continue-startup', () => {
      void launchDashboard();
    });
    ipcMain.handle('desktop:quit', () => app.quit());

    void beginStartup();
  });

  app.on('second-instance', () => {
    const window = dashboardWindow ?? splashWindow;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (serverOrigin) createDashboardWindow(serverOrigin);
    else {
      createSplashWindow();
      void beginStartup();
    }
  }
});

app.on('before-quit', event => {
  if (quitAllowed) return;
  event.preventDefault();
  if (!shutdownPromise) {
    shutdownPromise = stopServer().finally(() => {
      serverLog?.end();
      quitAllowed = true;
      app.quit();
    });
  }
});
