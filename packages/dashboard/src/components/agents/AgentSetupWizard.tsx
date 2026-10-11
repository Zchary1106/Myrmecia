import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentSummary, AgentSetupPreflight, AgentSetupDraft, AgentSetupForm } from '@myrmecia/shared';
import { agentSetupPayload } from '@myrmecia/shared';
import { api, ApiError } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useStore } from '../../stores/store';
import { AgentSetupDebug } from './AgentSetupDebug';
import { SetupDraftSession } from '../../lib/agent-setup-draft';
import { AgentContractEditor } from './AgentContractEditor';
import { getApiAuthToken } from '../../lib/auth';
import { AgentVersionHistory } from './AgentVersionHistory';
import { AgentEvaluationEditor } from './AgentEvaluationEditor';
import { AgentKnowledgeEditor } from './AgentKnowledgeEditor';
import { AgentBudgetEditor } from './AgentBudgetEditor';

interface AgentTemplate {
  name: string;
  emoji: string;
  role: string;
  description: string;
  capabilities: string;
  triggers: string;
  allowedTools: string[];
}

interface ToolPreset {
  id: string;
  label: string;
  hint: string;
}

interface ModelOption {
  value: string;
  label: string;
  hint: string;
}

export function AgentSetupWizard({
  open,
  onClose,
  templates,
  toolPresets,
  modelOptions,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  templates: AgentTemplate[];
  toolPresets: ToolPreset[];
  modelOptions: ModelOption[];
  onCreated: (agentId: string) => void;
}) {
  const {
    tools,
    skills,
    loadTools,
    loadSkills,
    loadSkillAssignments,
  } = useStore();
  const [step, setStep] = useState(0);
  const [selectedTemplateRole, setSelectedTemplateRole] = useState(templates[0]?.role || '');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [description, setDescription] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [systemInstructions, setSystemInstructions] = useState('');
  const [maxTurns, setMaxTurns] = useState(50);
  const [timeout, setTimeoutSeconds] = useState(300);
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [contractFields, setContractFields] = useState<Pick<AgentSetupForm, 'contractEnabled' | 'owns' | 'doesNotOwn' | 'escalatesTo' | 'definitionOfDone' | 'inputs' | 'outputs'>>({
    contractEnabled: false, owns: [], doesNotOwn: [], escalatesTo: [], definitionOfDone: [],
    inputs: [], outputs: [{ name: '答复', kind: 'markdown', required: true }],
  });
  const [capabilities, setCapabilities] = useState('');
  const [triggers, setTriggers] = useState('');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [model, setModel] = useState(modelOptions[0]?.value || 'openai/claude-sonnet-4.6');
  const [skillVersionId, setSkillVersionId] = useState('');
  const [testPrompt, setTestPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [createdAgent, setCreatedAgent] = useState<AgentSummary>();
  const [bound, setBound] = useState(false);
  const [testTaskId, setTestTaskId] = useState('');
  const [stage, setStage] = useState<'idle' | 'creating' | 'binding' | 'testing' | 'saved' | 'dispatched'>('idle');
  const [failedStage, setFailedStage] = useState<'creating' | 'binding' | 'testing'>();
  const [preflight, setPreflight] = useState<AgentSetupPreflight>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [locked, setLocked] = useState(false);
  const busyRef = useRef(false);
  const attemptRef = useRef<{
    key: string; testKey: string; payload: Partial<AgentSummary> & { name: string; role: string };
    skillVersionId: string; prompt: string;
  } | undefined>(undefined);
  const agentRef = useRef<AgentSummary | undefined>(undefined);
  const boundRef = useRef(false);
  const testTaskRef = useRef('');
  const generationRef = useRef(0);
  const [mcpTools, setMcpTools] = useState<Array<{ qualifiedName: string; name: string }>>([]);
  const [testLocked, setTestLocked] = useState(false);
  const testAttemptedRef = useRef(false);
  const testSubmittedRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => { void closeWizard(); };
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const draftSessionRef = useRef<SetupDraftSession | undefined>(undefined);
  const draftLoadRef = useRef(false);
  const [draftReady, setDraftReady] = useState(false);
  const [recoverable, setRecoverable] = useState<AgentSetupDraft[]>([]);
  const [draftStatus, setDraftStatus] = useState('');
  const [draftConflict, setDraftConflict] = useState(false);
  const draftConflictRef = useRef(false);
  const scopeGenerationRef = useRef(0);
  const authScopeRef = useRef(getApiAuthToken());

  const selectedTemplate = useMemo(
    () => templates.find(template => template.role === selectedTemplateRole) || templates[0],
    [templates, selectedTemplateRole],
  );

  const availableTools = useMemo(() => {
    const local = tools.length === 0 ? toolPresets.map(tool => ({ id: tool.id, name: tool.label, description: tool.hint }))
      : tools.map(tool => ({ id: tool.id, name: tool.name, description: `${tool.category} · ${tool.riskLevel}` }));
    const all = [...local, ...mcpTools.map(tool => ({ id: tool.qualifiedName, name: tool.name, description: 'MCP · 已发现；登录与权限需预检' }))];
    const known = new Set(all.map(tool => tool.id));
    return [...all, ...allowedTools.filter(id => !known.has(id)).map(id => ({ id, name: id, description: '未发现 / 未连接，请检查后再测试' }))];
  }, [tools, toolPresets, mcpTools, allowedTools]);

  const publishedSkillOptions = useMemo(
    () => skills.filter(skill => skill.publishedVersionId).map(skill => ({
      skillId: skill.id,
      versionId: skill.publishedVersionId!,
      label: skill.name,
      description: skill.description || skill.sourcePath || skill.id,
    })),
    [skills],
  );

  useEffect(() => {
    const checkScope = () => {
      if (authScopeRef.current === getApiAuthToken()) return;
      authScopeRef.current = getApiAuthToken();
      scopeGenerationRef.current++;
      draftSessionRef.current = undefined; draftLoadRef.current = false;
      attemptRef.current = undefined; agentRef.current = undefined; boundRef.current = false;
      testTaskRef.current = ''; testSubmittedRef.current = false; testAttemptedRef.current = false;
      setCreatedAgent(undefined); setBound(false); setTestTaskId(''); setTestPrompt('');
      setLocked(false); setTestLocked(false); setStage('idle'); setFailedStage(undefined);
      if (templates[0]) applyTemplate(templates[0]);
      setDraftReady(false); setRecoverable([]); draftConflictRef.current = true; setDraftConflict(true);
      setDraftStatus('账号或工作区已变更；请关闭后重新打开，重新加载当前账号草稿。');
    };
    window.addEventListener('storage', checkScope); window.addEventListener('focus', checkScope);
    return () => { window.removeEventListener('storage', checkScope); window.removeEventListener('focus', checkScope); };
  }, []);
  useEffect(() => {
    if (!open) return;
    void Promise.all([loadTools(), loadSkills()]);
    void api.mcp.tools().then(setMcpTools).catch(() => setMcpTools([]));
    if (draftLoadRef.current) return;
    draftLoadRef.current = true;
    const generation = scopeGenerationRef.current;
    if (selectedTemplate) applyTemplate(selectedTemplate);
    void api.agents.drafts.list().then(drafts => {
      if (generation !== scopeGenerationRef.current) return;
      if (drafts.length) setRecoverable(drafts);
      else {
        draftSessionRef.current = new SetupDraftSession();
        draftConflictRef.current = false; setDraftConflict(false); setDraftReady(true);
      }
    }).catch(() => {
      setDraftStatus('草稿加载失败；请重试后继续，避免覆盖未恢复的流程。');
      draftLoadRef.current = false;
    });
  }, [open]);

  useEffect(() => {
    if (!open || !selectedTemplate) return;
    if (attemptRef.current || recoverable.length) return;
    applyTemplate(selectedTemplate);
  }, [selectedTemplateRole]);

  useEffect(() => {
    if (attemptRef.current || draftReady || recoverable.length) return;
    if (!modelOptions.some(option => option.value === model) && modelOptions[0]) {
      setModel(modelOptions[0].value);
    }
  }, [modelOptions, model]);

  const configurationKey = JSON.stringify({ name, role, emoji, description, whenToUse, systemInstructions, capabilities, triggers,
    allowedTools, model, skillVersionId, maxTurns, timeout, maxConcurrent, contractFields });
  const draftForm = (): AgentSetupForm => ({
    name, role, emoji, description, whenToUse, systemInstructions, capabilities, triggers, allowedTools, model, skillVersionId,
    testPrompt, maxTurns, timeout, maxConcurrent, ...contractFields,
    owns: contractFields.owns.map(item => item.trim()).filter(Boolean),
    doesNotOwn: contractFields.doesNotOwn.map(item => item.trim()).filter(Boolean),
    escalatesTo: contractFields.escalatesTo.map(item => item.trim()).filter(Boolean),
    definitionOfDone: contractFields.definitionOfDone.map(item => item.trim()).filter(Boolean),
  });
  const draftDataRef = useRef({ form: draftForm(), step, locked, testSubmitted: testSubmittedRef.current });
  draftDataRef.current = { form: draftForm(), step, locked, testSubmitted: testSubmittedRef.current };
  const draftKey = JSON.stringify(draftDataRef.current);
  useEffect(() => {
    if (!open || !draftReady || saving || draftConflict) return;
    const timer = window.setTimeout(() => { void saveDraft().catch(() => undefined); }, 500);
    return () => window.clearTimeout(timer);
  }, [open, draftReady, draftKey, saving, draftConflict]);

  async function saveDraft(overrides?: Partial<{ locked: boolean; testSubmitted: boolean }>) {
    if (authScopeRef.current !== getApiAuthToken()) {
      scopeGenerationRef.current++; draftSessionRef.current = undefined;
      setDraftReady(false); draftConflictRef.current = true; setDraftConflict(true);
      throw new Error('账号已变更，请重新加载当前账号的草稿');
    }
    if (!draftSessionRef.current || draftConflictRef.current) throw new Error('请先恢复草稿或处理编辑冲突');
    const generation = scopeGenerationRef.current;
    setDraftStatus('正在保存草稿…');
    try {
      const draft = await draftSessionRef.current.save({ ...draftDataRef.current, ...overrides });
      if (generation !== scopeGenerationRef.current) throw new Error('账号或工作区已变更，请重新打开向导');
      setDraftStatus('草稿已保存 · 刷新后可恢复');
      return draft;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        draftConflictRef.current = true; setDraftConflict(true);
      }
      setDraftStatus(err instanceof Error ? err.message : '草稿保存失败');
      throw err;
    }
  }

  function restoreForm(form: AgentSetupForm) {
    setName(form.name); setRole(form.role); setEmoji(form.emoji); setDescription(form.description);
    setWhenToUse(form.whenToUse); setSystemInstructions(form.systemInstructions);
    setCapabilities(form.capabilities); setTriggers(form.triggers); setAllowedTools(form.allowedTools);
    setModel(form.model); setSkillVersionId(form.skillVersionId); setTestPrompt(form.testPrompt);
    setMaxTurns(form.maxTurns); setTimeoutSeconds(form.timeout); setMaxConcurrent(form.maxConcurrent);
    setContractFields({ contractEnabled: form.contractEnabled, owns: form.owns, doesNotOwn: form.doesNotOwn,
      escalatesTo: form.escalatesTo, definitionOfDone: form.definitionOfDone, inputs: form.inputs, outputs: form.outputs });
  }
  async function restoreDraft(id: string) {
    const generation = scopeGenerationRef.current;
    setDraftReady(false);
    try {
      const draft = await api.agents.drafts.get(id);
      const agent = draft.agentId ? await api.agents.get(draft.agentId) : undefined;
      if (generation !== scopeGenerationRef.current) return;
      draftSessionRef.current = new SetupDraftSession(draft);
      restoreForm(draft.form);
      setStep(draft.locked ? 3 : draft.step);
      agentRef.current = agent; setCreatedAgent(agent);
      boundRef.current = draft.bound; setBound(draft.bound);
      testTaskRef.current = draft.taskId || ''; setTestTaskId(draft.taskId || '');
      testSubmittedRef.current = draft.testSubmitted; testAttemptedRef.current = draft.testSubmitted;
      setLocked(draft.locked); setTestLocked(draft.testSubmitted); setStage(draft.stage === 'draft' ? 'idle' : draft.stage);
      attemptRef.current = draft.locked ? { key: draft.creationKey, testKey: draft.testKey,
        payload: payloadFor(draft.form), skillVersionId: draft.form.skillVersionId, prompt: draft.form.testPrompt.trim() } : undefined;
      setRecoverable([]); setDraftConflict(false); draftConflictRef.current = false;
      setError(''); setFailedStage(undefined); setPreflight(undefined);
      setDraftReady(true); setDraftStatus('已恢复草稿；不会自动提交或重跑任务');
    } catch (err) { setDraftStatus(err instanceof Error ? err.message : '恢复失败'); }
  }
  function startNewDraft() {
    scopeGenerationRef.current++;
    draftSessionRef.current = new SetupDraftSession();
    attemptRef.current = undefined; agentRef.current = undefined; boundRef.current = false; testTaskRef.current = '';
    testSubmittedRef.current = false; testAttemptedRef.current = false; draftConflictRef.current = false;
    setCreatedAgent(undefined); setBound(false); setTestTaskId(''); setLocked(false); setTestLocked(false);
    setDraftConflict(false); setRecoverable([]); setDraftReady(true); setStage('idle'); setStep(0);
    setTestPrompt(''); setError(''); setFailedStage(undefined); setPreflight(undefined);
    setDraftStatus('新草稿；原草稿和任务仍然保留');
    if (selectedTemplate) applyTemplate(selectedTemplate);
  }
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const targets = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') || [])];
      const first = targets[0], last = targets.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (!dialogRef.current?.contains(document.activeElement) || document.activeElement === dialogRef.current
        || !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    generationRef.current++;
    setPreflight(undefined);
    setCheckError('');
    setChecking(false);
  }, [configurationKey]);

  function payloadFor(form: AgentSetupForm) {
    return agentSetupPayload(form);
  }
  function payload() { return payloadFor(draftForm()); }

  async function checkCapabilities() {
    const generation = ++generationRef.current;
    setChecking(true); setCheckError('');
    try {
      const result = createdAgent ? await api.agents.preflightSaved(createdAgent.id)
        : await api.agents.preflight({ ...payload(), skillVersionId: skillVersionId || undefined });
      if (generation === generationRef.current) setPreflight(result);
    } catch {
      if (generation === generationRef.current) {
        setPreflight(undefined); setCheckError('预检失败，未确认当前能力。可以仅保存配置，连接恢复后重新检查。');
      }
    } finally { if (generation === generationRef.current) setChecking(false); }
  }

  if (!open) return null;

  function applyTemplate(template: AgentTemplate) {
    setName(template.name);
    setRole(template.role);
    setEmoji(template.emoji);
    setDescription(template.description);
    setWhenToUse(''); setSystemInstructions('');
    setContractFields({ contractEnabled: false, owns: [], doesNotOwn: [], escalatesTo: [], definitionOfDone: [],
      inputs: [], outputs: [{ name: '答复', kind: 'markdown', required: true }] });
    setMaxTurns(50); setTimeoutSeconds(300); setMaxConcurrent(1);
    setCapabilities(template.capabilities);
    setTriggers(template.triggers);
    setAllowedTools(template.allowedTools);
  }

  function toggleTool(toolId: string) {
    setAllowedTools(current => current.includes(toolId)
      ? current.filter(id => id !== toolId)
      : [...current, toolId]);
  }
  async function closeWizard() {
    if (savingRef.current || busyRef.current) return;
    if (draftReady && !draftConflictRef.current) {
      busyRef.current = true; setSaving(true);
      try { await saveDraft(); }
      catch { setError('草稿未保存；请重试保存后关闭，避免丢失本次编辑。'); return; }
      finally { busyRef.current = false; setSaving(false); }
    }
    onClose();
  }

  async function createAgent(runTest: boolean) {
    if (busyRef.current || !draftReady || draftConflictRef.current) return;
    if (!name.trim() || !role.trim() || !description.trim()) {
      setError('Name, role and description are required');
      return;
    }
    if (runTest && (!testSubmittedRef.current && (!preflight?.canTest || checking) || !testPrompt.trim())) return;
    const generation = scopeGenerationRef.current;
    const assertScope = () => {
      if (generation !== scopeGenerationRef.current || authScopeRef.current !== getApiAuthToken()) throw new Error('账号或草稿已变更，操作已停止；请恢复原流程');
    };
    if (contractFields.contractEnabled && (!draftForm().owns.length || !draftForm().definitionOfDone.length || !contractFields.outputs.length)) {
      setError('职责契约需要至少一项负责范围、完成标准和交付产物'); return;
    }
    busyRef.current = true;
    setSaving(true); setLocked(true);
    setError('');
    setFailedStage(undefined);
    let currentStage: 'creating' | 'binding' | 'testing' = 'creating';
    try {
      await saveDraft();
      const draft = await saveDraft({ locked: true });
      assertScope();
      if (!attemptRef.current) attemptRef.current = {
        key: draft.creationKey, testKey: draft.testKey, payload: payload(),
        skillVersionId, prompt: testPrompt.trim(),
      };
      const attempt = attemptRef.current;
      if (runTest && !testAttemptedRef.current) {
        attempt.prompt = testPrompt.trim();
        testAttemptedRef.current = true; setTestLocked(true);
      }
      setStage('creating');
      if (!agentRef.current) {
        const created = await api.agents.create(attempt.payload, attempt.key);
        assertScope();
        agentRef.current = created; setCreatedAgent(created);
        useStore.setState(state => ({ agents: [created, ...state.agents.filter(agent => agent.id !== created.id)] }));
        try {
          Promise.resolve(onCreated(created.id)).catch(() => undefined);
        } catch { /* View callbacks cannot invalidate a persisted creation. */ }
      }
      const created = agentRef.current;
      if (!boundRef.current) {
        currentStage = 'binding'; setStage('binding');
        if (attempt.skillVersionId) await api.skills.assign(created.id, attempt.skillVersionId);
        assertScope();
        boundRef.current = true; setBound(true);
        void loadSkillAssignments();
      }
      if (runTest && !testTaskRef.current) {
        currentStage = 'testing'; setStage('testing');
        if (!testSubmittedRef.current) {
          const checked = await api.agents.preflightSaved(created.id);
          assertScope();
          setPreflight(checked);
          if (!checked.canTest) throw new Error('当前有阻塞项；Agent 已保存，请解决能力检查后重试测试。');
        }
        // Once submitted, replay the same key even if readiness changed: the
        // server may already have accepted it before the response was lost.
        await saveDraft({ locked: true, testSubmitted: true });
        assertScope();
        testSubmittedRef.current = true;
        const run = await api.agents.test(created.id, attempt.prompt, attempt.testKey);
        assertScope();
        testTaskRef.current = run.taskId; setTestTaskId(run.taskId);
      }
      setStage(testTaskRef.current ? 'dispatched' : 'saved');
    } catch (err: any) {
      setFailedStage(currentStage);
      setError(`${currentStage === 'creating' ? '创建结果未确认：重试会复用原请求，不创建第二个 Agent。'
        : currentStage === 'binding' ? 'Agent 已创建，Skill 绑定失败：重试只补齐绑定。'
        : 'Agent 已保存，试运行提交失败：重试会核对同一个测试任务。'} ${err.message || '请稍后重试。'}`);
    } finally {
      busyRef.current = false; setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <button disabled={saving} className="absolute inset-0 bg-black/60" onClick={() => void closeWizard()} aria-label="Close setup wizard" />
      <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="agent-setup-title" className="absolute left-1/2 top-1/2 max-h-[90vh] w-[920px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="border-b border-border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-accent-light">One-click setup</div>
              <h3 id="agent-setup-title" className="mt-1 text-xl font-semibold">创建与调试 Agent</h3>
              <p className="mt-1 text-sm text-app-muted">先保存配置，再检查能力与试运行。执行结束不等于验收通过。</p>
            </div>
            <button disabled={saving} onClick={() => void closeWizard()} className="app-focus rounded-lg bg-background px-3 py-1.5 text-xs text-app-secondary hover:bg-surface-hover disabled:opacity-40">Close</button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" aria-label="创建草稿">
            <span className="text-app-muted" role="status">{draftStatus || '正在加载草稿…'}</span>
            {draftConflict && draftSessionRef.current && <button className="app-focus rounded px-2 py-1 text-accent-light"
              onClick={() => void restoreDraft(draftSessionRef.current!.id)}>重新加载草稿</button>}
            {!saving && <button className="app-focus rounded px-2 py-1 text-app-secondary" onClick={startNewDraft}>新建草稿</button>}
            {!draftReady && !recoverable.length && <button className="app-focus rounded px-2 py-1 text-accent-light"
              onClick={() => { void api.agents.drafts.list().then(drafts => {
                if (drafts.length) setRecoverable(drafts); else startNewDraft();
              }).catch(() => setDraftStatus('草稿服务仍不可用，请稍后重试')); }}>重试加载草稿</button>}
          </div>
          {!!recoverable.length && <section className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3" aria-label="恢复创建草稿">
            <p className="text-sm font-medium">发现未清理的创建草稿</p>
            <p className="text-xs text-app-muted">请选择恢复；不会自动提交测试。丢弃只删除草稿，不删除 Agent 或任务。</p>
            {recoverable.map(draft => <div key={draft.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate">{draft.form.name || '未命名 Agent'} · {draft.stage}</span>
              <div className="flex shrink-0 gap-2">
                <button className="app-focus rounded px-2 py-1 text-accent-light" onClick={() => void restoreDraft(draft.id)}>恢复草稿</button>
                <button className="app-focus rounded px-2 py-1 text-app-muted" onClick={() => {
                  if (!window.confirm('只丢弃该创建草稿，已创建的 Agent 和任务会保留。继续？')) return;
                  void api.agents.drafts.discard(draft.id).then(() => {
                    setRecoverable(items => items.filter(item => item.id !== draft.id));
                  }).catch(err => setDraftStatus(err.message));
                }}>丢弃草稿</button>
              </div>
            </div>)}
          </section>}
          <div className="mt-4 grid grid-cols-4 gap-2">
            {['Template', 'Skill', 'Tools & Model', 'Test'].map((label, index) => (
              <button
                key={label}
                disabled={saving || locked && index < 3}
                onClick={() => setStep(index)}
                className={cn(
                  'rounded-lg px-3 py-2 text-xs font-semibold',
                  step === index ? 'bg-accent/20 text-accent-light' : 'bg-background text-app-muted hover:text-app-primary',
                )}
              >
                {index + 1}. {label}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[62vh] overflow-y-auto p-5">
          <fieldset disabled={locked || saving} className="min-w-0">
          {step === 0 && (
            <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
              <div className="space-y-2">
                {templates.map(template => (
                  <button
                    key={template.role}
                    onClick={() => setSelectedTemplateRole(template.role)}
                    className={cn(
                      'w-full rounded-xl border p-3 text-left',
                      selectedTemplateRole === template.role ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30',
                    )}
                  >
                    <div className="text-sm font-semibold"><span className="mr-2">{template.emoji}</span>{template.name}</div>
                    <div className="mt-1 text-[11px] text-app-muted">{template.role}</div>
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                <Field label="Name"><input value={name} onChange={event => setName(event.target.value)} className={inputClass} /></Field>
                <div className="grid grid-cols-[86px_1fr] gap-3">
                  <Field label="Emoji"><input value={emoji} onChange={event => setEmoji(event.target.value)} className={inputClass} /></Field>
                  <Field label="Role"><input value={role} onChange={event => setRole(event.target.value)} className={inputClass} /></Field>
                </div>
                <Field label="职责简介 / Mission">
                  <textarea value={description} onChange={event => setDescription(event.target.value)} rows={5} className={cn(inputClass, 'resize-none')} />
                </Field>
                <Field label="何时调用 / Routing（可选）"><textarea value={whenToUse} rows={2}
                  onChange={event => setWhenToUse(event.target.value)} className={inputClass} /></Field>
                <Field label="系统指令 / System instructions（可选）"><textarea value={systemInstructions} rows={4}
                  onChange={event => setSystemInstructions(event.target.value)} className={inputClass} /></Field>
                <AgentContractEditor value={contractFields} onChange={patch => setContractFields(current => ({ ...current, ...patch }))} />
                <Field label="Capabilities"><input value={capabilities} onChange={event => setCapabilities(event.target.value)} className={inputClass} /></Field>
                <Field label="Triggers"><input value={triggers} onChange={event => setTriggers(event.target.value)} className={inputClass} /></Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="grid gap-3 md:grid-cols-2">
              <button
                onClick={() => setSkillVersionId('')}
                className={cn('rounded-xl border p-4 text-left', !skillVersionId ? 'border-accent/50 bg-accent/10' : 'border-border bg-background')}
              >
                <div className="text-sm font-semibold">Use inline description</div>
                <div className="mt-1 text-xs text-app-muted">使用职责简介和独立系统指令，不绑定 Skill 版本；路由描述仅用于说明何时调用。</div>
              </button>
              {publishedSkillOptions.map(skill => (
                <button
                  key={skill.versionId}
                  onClick={() => setSkillVersionId(skill.versionId)}
                  className={cn('rounded-xl border p-4 text-left', skillVersionId === skill.versionId ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30')}
                >
                  <div className="text-sm font-semibold">{skill.label}</div>
                  <div className="mt-1 text-xs text-app-muted">{skill.description}</div>
                  <div className="mt-2 text-[10px] text-app-muted">{skill.versionId}</div>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="mb-3 text-sm font-semibold text-app-secondary">Allowed tools</h4>
                <div className="space-y-2">
                  {availableTools.map(tool => (
                    <label key={tool.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background p-3 hover:border-accent/30">
                      <input type="checkbox" checked={allowedTools.includes(tool.id)} onChange={() => toggleTool(tool.id)} className="mt-1" />
                      <span>
                        <span className="block text-sm font-semibold">{tool.name}</span>
                        <span className="block text-[11px] text-app-muted">{tool.id} · {tool.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="mb-3 text-sm font-semibold text-app-secondary">Model</h4>
                <select value={model} onChange={event => setModel(event.target.value)} className={inputClass}>
                  {!modelOptions.some(option => option.value === model) && <option value={model}>{model} · 当前目录未发现</option>}
                  {modelOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label} — {option.hint}</option>
                  ))}
                </select>
                <div className="mt-4 rounded-xl border border-border bg-background p-4 text-xs leading-relaxed text-app-muted">
                  推荐：高复杂度 Agent 使用 Claude Sonnet / GPT 大模型；工具型、内容型任务可优先使用均衡或 mini 模型降低成本。
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Field label="最大轮数"><input type="number" min={1} max={200} value={maxTurns}
                    onChange={event => setMaxTurns(Number(event.target.value))} className={inputClass} /></Field>
                  <Field label="超时（秒）"><input type="number" min={10} max={3600} value={timeout}
                    onChange={event => setTimeoutSeconds(Number(event.target.value))} className={inputClass} /></Field>
                  <Field label="并发上限"><input type="number" min={1} max={8} value={maxConcurrent}
                    onChange={event => setMaxConcurrent(Number(event.target.value))} className={inputClass} /></Field>
                </div>
                <p className="mt-2 text-xs text-app-muted">当前设置受服务端全局上限约束；保存 Agent 后可在「执行限额与预算」配置 Token、工具和美元配额。</p>
              </div>
            </div>
          )}

          </fieldset>
          {step === 3 && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Summary label="Agent" value={`${emoji} ${name || '-'}`} />
                <Summary label="Role" value={role || '-'} />
                <Summary label="Model" value={model || '-'} />
                <Summary label="Tools" value={`${allowedTools.length} selected`} />
                <Summary label="Skill" value={skillVersionId || 'inline'} />
                <Summary label="Capabilities" value={capabilities || '-'} />
              </div>
              <section aria-label="Capability preflight" className="space-y-3 rounded-xl bg-background/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">运行前能力检查</h4>
                  <button type="button" disabled={checking || saving} onClick={() => void checkCapabilities()}
                    className="app-focus rounded-lg px-3 py-2 text-xs text-accent-light hover:bg-surface-hover disabled:opacity-40">
                    {checking ? '正在检查…' : '检查能力'}
                  </button>
                </div>
                <p className="text-xs text-app-muted">只读取目录、连接和登录缓存，不调用模型、不自动登录、不执行工具。未检查也可以仅保存。</p>
                {checkError && <p role="alert" className="text-xs text-red-500">{checkError}</p>}
                {preflight && <>
                  <p className="text-[11px] text-app-muted">检查时间：{new Date(preflight.checkedAt).toLocaleTimeString()} · 当前快照，不是端到端验收。</p>
                  <p role="status" className="text-xs text-app-secondary">{preflight.canTest ? '可提交试运行；仍需通过实际调用验证。' : '存在阻塞项，暂不能试运行。'}</p>
                  <ul className="divide-y divide-border/60">
                    {preflight.checks.map(check => <li key={check.id} className="py-2 text-xs">
                      <div className="flex justify-between gap-3"><span className="font-medium [overflow-wrap:anywhere]">{check.label}</span>
                        <span className="shrink-0 text-app-muted">{{ available: '可用记录', requires_approval: '需审批', unavailable: '不可用', unknown: '未验证' }[check.status]}</span></div>
                      <p className="mt-1 text-app-muted">{check.message}</p>
                    </li>)}
                  </ul>
                </>}
              </section>
              {createdAgent && <section aria-label="Setup progress" className="rounded-lg bg-surface-hover/60 p-3 text-xs">
                <p className="font-medium">Agent 已创建 · {createdAgent.name}</p>
                <p className="mt-1 text-app-muted">Skill：{bound ? skillVersionId ? '已绑定' : '使用内联指令' : '尚未完成绑定'} · 试运行：{testTaskId ? '已提交，结果见下方' : '尚未提交'}</p>
                <p className="mt-1 text-app-muted [overflow-wrap:anywhere]">{createdAgent.id}</p>
              </section>}
              <Field label="测试指令（可选）">
                <textarea
                  aria-label="单次测试指令"
                  value={testPrompt}
                  onChange={event => setTestPrompt(event.target.value)}
                  rows={5}
                  disabled={testLocked || saving}
                  className={cn(inputClass, 'resize-none')}
                  placeholder="创建后立即运行一次测试；留空则只创建 Agent。"
                />
              </Field>
              <p className="text-xs text-app-muted">试运行会使用实际模型和当前允许的工具，可能消耗额度。不会绕过审批或自动获得发布权限。关闭窗口不会停止已提交的任务，可在会话列表继续查看。</p>
              {testTaskId && <AgentSetupDebug taskId={testTaskId} agentName={createdAgent?.name || name} />}
              {createdAgent && <><details className="rounded-lg border border-border p-3">
                <summary className="app-focus cursor-pointer text-xs text-app-secondary">配置版本 / 发布与回滚</summary>
                <div className="mt-3"><AgentVersionHistory agentId={createdAgent.id} /></div>
              </details><details className="rounded-lg border border-border p-3">
                <summary className="app-focus cursor-pointer text-xs text-app-secondary">管理回归测试套件</summary>
                <div className="mt-3"><AgentEvaluationEditor key={createdAgent.id} agentId={createdAgent.id} /></div>
              </details><details className="rounded-lg border border-border p-3">
                <summary className="app-focus cursor-pointer text-xs text-app-secondary">知识来源与访问范围</summary>
                <div className="mt-3"><AgentKnowledgeEditor key={createdAgent.id} agentId={createdAgent.id} /></div>
              </details><details className="rounded-lg border border-border p-3">
                <summary className="app-focus cursor-pointer text-xs text-app-secondary">执行限额与预算</summary>
                <div className="mt-3"><AgentBudgetEditor key={`budget:${createdAgent.id}`} agentId={createdAgent.id} /></div>
              </details></>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-5">
          <div className="min-w-0 text-xs text-red-500" role={error ? 'alert' : undefined}>{error || saving && { idle: '', creating: '正在保存 Agent…', binding: '正在绑定 Skill…', testing: '正在提交试运行…', saved: '', dispatched: '' }[stage]}</div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button disabled={step === 0 || saving || locked} onClick={() => setStep(step - 1)} className="app-focus rounded-lg bg-background px-4 py-2 text-sm text-app-secondary disabled:opacity-40">
              Back
            </button>
            {step < 3 ? (
              <button onClick={() => setStep(step + 1)} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Next</button>
            ) : (
              <>
                {!testTaskId && <button disabled={!draftReady || draftConflict || saving || failedStage === 'testing'} onClick={() => void createAgent(false)} className="app-focus rounded-lg bg-background px-4 py-2 text-sm text-app-secondary hover:bg-surface-hover disabled:opacity-40">
                  {failedStage === 'binding' ? '重试 Skill 绑定' : failedStage === 'creating' ? '重试保存' : createdAgent ? '仅保存，不试运行' : '仅保存 Agent'}
                </button>}
                {!testTaskId && <button disabled={!draftReady || draftConflict || saving || !testSubmittedRef.current && (checking || !preflight?.canTest) || !testPrompt.trim()} onClick={() => void createAgent(true)} className="app-focus rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  {failedStage === 'testing' ? '重试原试运行' : createdAgent ? '开始试运行' : '保存并试运行'}
                </button>}
                {createdAgent && <button disabled={saving} onClick={() => void closeWizard()} className="app-focus rounded-lg px-3 py-2 text-sm text-app-secondary hover:bg-surface-hover">完成</button>}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const inputClass = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-app-secondary">{label}</span>
      {children}
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="text-[10px] text-app-muted">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}
