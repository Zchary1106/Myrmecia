const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const quit = document.querySelector('#quit');
const doctorButton = document.querySelector('#doctor-button');
const doctor = document.querySelector('#doctor');
const providerOptions = document.querySelector('#provider-options');
const runtimeConfig = document.querySelector('#runtime-config');
const provider = document.querySelector('#provider');
const baseUrlField = document.querySelector('#base-url-field');
const baseUrl = document.querySelector('#base-url');
const modelField = document.querySelector('#model-field');
const model = document.querySelector('#model');
const apiKeyField = document.querySelector('#api-key-field');
const apiKey = document.querySelector('#api-key');
const storageStatus = document.querySelector('#storage-status');
const saveConfig = document.querySelector('#save-config');
const continueWithoutConfig = document.querySelector('#continue-without-config');
const footerTitle = document.querySelector('#footer-title');
const footerMeta = document.querySelector('#footer-meta');
const footerDot = document.querySelector('#footer-dot');
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const COPILOT_DEFAULT_MODEL = 'auto';
let secureStorageAvailable = false;

function renderState(state) {
  const showConfiguration = state.phase === 'configuration' || state.phase === 'failed';
  status.textContent = state.message;
  status.classList.toggle('failed', state.phase === 'failed');
  status.classList.toggle('pulse', state.phase === 'starting');
  retry.hidden = state.phase !== 'failed';
  retry.disabled = state.phase !== 'failed';
  quit.hidden = state.phase !== 'failed';
  providerOptions.hidden = !showConfiguration;
  runtimeConfig.hidden = !showConfiguration;

  const footer = {
    configuration: ['本地工作区待启动', 'NODE · WORKSPACE · CREDENTIALS / LOCAL ONLY', '#b7f36b'],
    starting: ['正在启动本地工作区', 'STARTING LOCAL SERVER · PLEASE WAIT', '#ffd17a'],
    ready: ['本地工作区已就绪', 'SERVER · DASHBOARD · WORKSPACE / READY', '#8ee6b1'],
    failed: ['本地工作区启动失败', 'CHECK CONFIGURATION OR RUN DOCTOR', '#ff9696'],
  }[state.phase];
  footerTitle.lastChild.textContent = footer[0];
  footerMeta.textContent = footer[1];
  footerDot.style.background = footer[2];
  footerDot.style.boxShadow = `0 0 12px ${footer[2]}70`;
}

function setFieldVisibility(field, visible) {
  field.hidden = !visible;
  field.style.display = visible ? '' : 'none';
}

function renderProvider(providerName, applyDefaults = false) {
  const isCopilot = providerName === 'copilot';
  const isDeepSeek = providerName === 'deepseek';
  setFieldVisibility(baseUrlField, !isCopilot);
  setFieldVisibility(apiKeyField, !isCopilot);
  setFieldVisibility(modelField, !isCopilot);
  for (const option of providerOptions.querySelectorAll('[data-provider-choice]')) {
    const selected = option.dataset.providerChoice === providerName;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', String(selected));
    option.querySelector('.provider-action').textContent = selected ? '↵ 配置' : '选择 →';
  }

  if (isDeepSeek && applyDefaults) {
    baseUrl.value = DEEPSEEK_BASE_URL;
    model.value = DEEPSEEK_DEFAULT_MODEL;
  }
  if (isCopilot) {
    apiKey.value = '';
    if (applyDefaults || !model.value) model.value = COPILOT_DEFAULT_MODEL;
    model.placeholder = '留空则由 Copilot SDK 选择默认模型';
  } else if (isDeepSeek) {
    model.placeholder = DEEPSEEK_DEFAULT_MODEL;
  } else {
    model.placeholder = 'gpt-5.4-mini';
  }
  saveConfig.disabled = !isCopilot && !secureStorageAvailable;
  saveConfig.textContent = isCopilot
    ? '使用 GitHub Copilot 启动'
    : isDeepSeek
      ? '保存 DeepSeek 配置并启动'
      : '保存配置并启动';
}

async function loadRuntimeConfig() {
  const config = await window.myrmeciaDesktop.getRuntimeConfig();
  secureStorageAvailable = config.secureStorageAvailable;
  const isUntouchedGenericConfig = config.provider === 'openai-compatible'
    && !config.baseUrl
    && !config.model
    && !config.apiKeyConfigured;
  const selectedProvider = isUntouchedGenericConfig ? 'copilot' : config.provider;
  provider.value = selectedProvider;
  baseUrl.value = selectedProvider === 'deepseek' && isUntouchedGenericConfig ? '' : config.baseUrl;
  model.value = selectedProvider === 'deepseek' && isUntouchedGenericConfig ? '' : config.model;
  renderProvider(selectedProvider, isUntouchedGenericConfig);
  storageStatus.textContent = selectedProvider === 'copilot'
    ? '使用本机已登录的 GitHub Copilot 凭据；启动后可在 Models 页面切换当前账号可用模型。'
    : config.recoveryMessage
      ? `${config.recoveryMessage} 请输入新的 API Key 以替换损坏的配置。`
      : (config.secureStorageAvailable
      ? (config.apiKeyConfigured
        ? '已配置 API Key；留空会保留当前凭据。'
        : 'API Key 将通过系统凭据库加密保存。')
      : '系统凭据库不可用；请通过环境变量提供 API Key，或仅启动仪表板。');
}

async function refresh() {
  const state = await window.myrmeciaDesktop.getStartupState();
  renderState(state);
  if (state.phase === 'configuration') await loadRuntimeConfig();
}

const unsubscribeStartupState = window.myrmeciaDesktop.onStartupStateChange(state => {
  renderState(state);
  if (state.phase === 'configuration') void loadRuntimeConfig();
});

window.addEventListener('beforeunload', unsubscribeStartupState);

retry.addEventListener('click', async () => {
  retry.disabled = true;
  renderState({ phase: 'starting', message: '正在重新启动本地服务…' });
  window.myrmeciaDesktop.retryStartup();
});

quit.addEventListener('click', () => window.myrmeciaDesktop.quit());

runtimeConfig.addEventListener('submit', async event => {
  event.preventDefault();
  saveConfig.disabled = true;
  status.textContent = '正在安全保存模型配置…';
  try {
    await window.myrmeciaDesktop.saveRuntimeConfig({
      provider: provider.value,
      baseUrl: baseUrl.value,
      model: provider.value === 'copilot' ? undefined : model.value,
      apiKey: provider.value === 'copilot' ? undefined : apiKey.value || undefined,
    });
    renderState({ phase: 'starting', message: '模型配置已安全保存，正在启动本地服务…' });
    window.myrmeciaDesktop.continueStartup();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '无法保存模型配置。';
    status.classList.add('failed');
    saveConfig.disabled = false;
  }
});

provider.addEventListener('change', () => {
  renderProvider(provider.value, true);
  storageStatus.textContent = provider.value === 'copilot'
    ? '使用本机已登录的 GitHub Copilot 凭据；启动后可在 Models 页面切换当前账号可用模型。'
    : provider.value === 'deepseek'
      ? 'DeepSeek 使用官方 OpenAI-compatible 直连接口；请输入 DeepSeek API Key。'
      : '请输入兼容 OpenAI API 的 Base URL、模型名称与 API Key。';
});

for (const option of providerOptions.querySelectorAll('[data-provider-choice]')) {
  option.addEventListener('click', () => {
    provider.value = option.dataset.providerChoice;
    renderProvider(provider.value, true);
    storageStatus.textContent = provider.value === 'copilot'
      ? '使用本机已登录的 GitHub Copilot 凭据；启动后可在 Models 页面切换当前账号可用模型。'
      : provider.value === 'deepseek'
        ? 'DeepSeek 使用官方 OpenAI-compatible 直连接口；请输入 DeepSeek API Key。'
        : '请输入兼容 OpenAI API 的 Base URL、模型名称与 API Key。';
  });
}

document.addEventListener('keydown', event => {
  const providerOption = event.target instanceof Element
    ? event.target.closest('[data-provider-choice]')
    : null;
  const isBackground = event.target === document.body || event.target === document.documentElement;
  if (
    providerOptions.hidden
    || runtimeConfig.contains(event.target)
    || (!providerOption && !isBackground)
  ) return;
  const options = Array.from(providerOptions.querySelectorAll('[data-provider-choice]'));
  const selectedIndex = Math.max(0, options.findIndex(option => option.dataset.providerChoice === provider.value));
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = options[(selectedIndex + direction + options.length) % options.length];
    next.click();
    next.focus({ preventScroll: true });
  } else if (event.key === 'Enter' && !saveConfig.disabled) {
    event.preventDefault();
    saveConfig.click();
  }
});

continueWithoutConfig.addEventListener('click', async () => {
  continueWithoutConfig.disabled = true;
  renderState({ phase: 'starting', message: '正在启动本地服务…' });
  window.myrmeciaDesktop.continueStartup();
});

doctorButton.addEventListener('click', async () => {
  doctorButton.disabled = true;
  doctor.hidden = false;
  doctor.replaceChildren();
  const checks = await window.myrmeciaDesktop.runDoctor();
  for (const check of checks) {
    const item = document.createElement('li');
    item.className = check.status;
    item.textContent = `${check.name}: ${check.detail}`;
    doctor.append(item);
  }
  doctorButton.disabled = false;
});

void refresh();
