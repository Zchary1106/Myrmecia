import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores/store';
import { api, type DomainPackDTO, type TeamDTO } from '../../lib/api';
import { cn } from '../../lib/utils';
import { readOnlyControlMessage, runtimeControlsAllowed } from '../../lib/permissions';
import type { Priority, TaskMode } from '@myrmecia/shared';

export type LaunchMode = Extract<TaskMode, 'direct' | 'master'> | 'team' | 'pipeline';

function taskTitleFromGoal(goal: string): string {
  const compact = goal.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) return compact;
  return `${compact.slice(0, 69)}…`;
}

export function WorkLauncher({
  initialInput = '',
  initialMode = 'master',
  initialTeamId = '',
  initialTemplateId = '',
  initialWorkspacePath = '',
  initialModelId = 'auto',
  initialReasoningEffort = 'auto',
  initialContextLength = 'auto',
  onClose,
  onCreated,
}: {
  initialInput?: string;
  initialMode?: LaunchMode;
  initialTeamId?: string;
  initialTemplateId?: string;
  initialWorkspacePath?: string;
  initialModelId?: string;
  initialReasoningEffort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  initialContextLength?: 'auto' | '32000' | '128000' | '200000' | '1050000';
  onClose: () => void;
  onCreated?: () => void | Promise<void>;
}) {
  const {
    agents, templates, diagnostics,
    loadTasks, loadPipelines, loadTemplates, setActiveView,
  } = useStore();
  const [mode, setMode] = useState<LaunchMode>(initialMode);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState(initialInput);
  const [assigneeId, setAssigneeId] = useState('');
  const [templateId, setTemplateId] = useState(initialTemplateId);
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamId, setTeamId] = useState(initialTeamId);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const [modelId, setModelId] = useState(initialModelId);
  const [reasoningEffort, setReasoningEffort] = useState(initialReasoningEffort);
  const [contextLength, setContextLength] = useState(initialContextLength);
  const [gateMode, setGateMode] = useState<'auto' | 'manual'>('auto');
  const [confirmAutonomousPublish, setConfirmAutonomousPublish] = useState(false);
  const [priority, setPriority] = useState<Priority>('normal');
  const [domains, setDomains] = useState<DomainPackDTO[]>([]);
  const [domainId, setDomainId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canLaunch = runtimeControlsAllowed(diagnostics);

  useEffect(() => {
    if (templates.length === 0) void loadTemplates();
    api.domains.list().then(setDomains).catch(() => { /* domains optional */ });
    api.teams.list().then(next => {
      setTeams(next);
      setTeamId(current => current || next[0]?.id || '');
    }).catch(() => { /* teams optional */ });
    if (!initialWorkspacePath) {
      void window.myrmeciaDesktopIntegrations?.getWorkspace().then(workspace => {
        setWorkspacePath(workspace.path);
      }).catch(() => {});
    }
  }, [initialWorkspacePath]);

  useEffect(() => {
    if (initialTeamId) setTeamId(initialTeamId);
    if (initialTemplateId) setTemplateId(initialTemplateId);
    if (initialWorkspacePath) setWorkspacePath(initialWorkspacePath);
    setModelId(initialModelId);
    setReasoningEffort(initialReasoningEffort);
    setContextLength(initialContextLength);
    setMode(initialMode);
  }, [initialContextLength, initialMode, initialModelId, initialReasoningEffort, initialTeamId, initialTemplateId, initialWorkspacePath]);

  useEffect(() => {
    if (mode === 'pipeline' && !templateId && templates[0]) {
      setTemplateId(templates[0].id);
    }
  }, [mode, templateId, templates]);

  const selectedTemplate = templates.find(template => template.id === templateId);
  const directAgents = useMemo(
    () => agents.filter(agent => agent.role !== 'orchestrator'),
    [agents],
  );

  const validationError = useMemo(() => {
    if (!canLaunch) return readOnlyControlMessage;
    if (!description.trim()) return 'Input or description is required.';
    if (mode !== 'master' && !title.trim()) return 'Title is required.';
    if (mode === 'direct' && !assigneeId) return 'Select an agent for direct work.';
    if (mode === 'team' && !teamId) return 'Select an Agent Team.';
    if (mode === 'team' && !workspacePath) return 'Choose a local project in Agent Teams before dispatching.';
    if (mode === 'pipeline' && !templateId) return 'Select a pipeline template.';
    return null;
  }, [canLaunch, title, description, mode, assigneeId, teamId, templateId, workspacePath]);

  const submit = async () => {
    if (validationError || busy) return;
    setBusy(true);
    setError(null);
    const taskTitle = title.trim() || taskTitleFromGoal(description);
    try {
      if (mode === 'team') {
        await api.teams.dispatch(teamId, `${title.trim()}\n\n${description.trim()}`, workspacePath, {
          modelId: modelId === 'auto' ? undefined : modelId,
          reasoningEffort: reasoningEffort === 'auto' ? undefined : reasoningEffort,
          contextLength: contextLength === 'auto' ? undefined : Number(contextLength),
        });
        setActiveView('teams');
      } else if (mode === 'pipeline') {
        await api.pipelines.create({
          name: taskTitle,
          templateId,
          input: description.trim(),
          gateMode,
          confirmAutonomousPublish,
          domainId: domainId || undefined,
        });
        await loadPipelines();
      } else {
        if (mode === 'master') {
          await api.supervisor.dispatch(description.trim(), {
            modelId: modelId === 'auto' ? undefined : modelId,
            reasoningEffort: reasoningEffort === 'auto' ? undefined : reasoningEffort,
            contextLength: contextLength === 'auto' ? undefined : Number(contextLength),
            workspacePath: workspacePath || undefined,
            workspaceMode: Boolean(workspacePath),
          });
        } else {
          await api.tasks.create({
            title: taskTitle,
            description: description.trim(),
            mode,
            priority,
            assigneeId: mode === 'direct' ? assigneeId : undefined,
            input: description.trim(),
            modelId: modelId === 'auto' ? undefined : modelId,
            reasoningEffort: reasoningEffort === 'auto' ? undefined : reasoningEffort,
            contextLength: contextLength === 'auto' ? undefined : Number(contextLength),
            workspacePath: workspacePath || undefined,
            domainId: domainId || undefined,
          });
        }
        await loadTasks();
      }
      await onCreated?.();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-[640px] max-w-[calc(100vw-2rem)] p-6" onClick={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h3 className="text-lg font-bold">Launch work</h3>
            <p className="text-[12px] text-gray-500 mt-1">
              Start with Auto routing, or choose an explicit Team, Agent, or Workflow when needed.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close launch work" className="app-focus rounded-lg px-2 py-1 text-gray-500 transition hover:bg-surface-hover hover:text-white">×</button>
        </div>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              { id: 'master' as const, title: 'Auto', detail: 'Agent decides the route', icon: '🧠' },
              { id: 'direct' as const, title: 'Direct', detail: 'Assign one agent', icon: '🎯' },
              { id: 'team' as const, title: 'Team', detail: 'Use a specialist squad', icon: '🐜' },
              { id: 'pipeline' as const, title: 'Pipeline', detail: 'Run a template flow', icon: '🔗' },
            ]).map(option => (
              <button
                key={option.id}
                onClick={() => setMode(option.id)}
                className={cn(
                  'text-left border rounded-xl p-3 transition',
                  mode === option.id ? 'border-accent bg-accent/10' : 'border-border bg-background hover:border-accent/30',
                )}
              >
                <div className="text-lg">{option.icon}</div>
                <div className="text-sm font-semibold mt-1">{option.title}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">{option.detail}</div>
              </button>
            ))}
          </div>

          <div className="grid gap-3">
            {mode !== 'master' && (
              <input
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder={mode === 'pipeline' ? 'Pipeline name' : 'Task title'}
                disabled={!canLaunch}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
              />
            )}
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="Describe the goal, requirements, constraints, and expected output..."
              rows={5}
              disabled={!canLaunch}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none resize-none disabled:opacity-50"
            />
          </div>

          {mode === 'direct' && (
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Agent</label>
              <select
                value={assigneeId}
                onChange={event => setAssigneeId(event.target.value)}
                disabled={!canLaunch}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
              >
                <option value="">Select agent...</option>
                {directAgents.map(agent => (
                  <option key={agent.id} value={agent.id}>{agent.emoji} {agent.name} ({agent.role})</option>
                ))}
              </select>
            </div>
          )}

          {mode === 'team' && (
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Agent Team</label>
              <select
                value={teamId}
                onChange={event => setTeamId(event.target.value)}
                disabled={!canLaunch || teams.length === 0}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
              >
                <option value="">Select team...</option>
                {teams.map(team => <option key={team.id} value={team.id}>{team.emoji} {team.name}</option>)}
              </select>
              <div className="mt-2 rounded-lg border border-border bg-background p-3 text-[11px] text-gray-500">
                Project: {workspacePath || 'No local project selected. Open Agent Teams and choose a folder.'}
              </div>
            </div>
          )}

          {mode !== 'pipeline' && mode !== 'team' && (
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Priority</label>
              <select
                value={priority}
                onChange={event => setPriority(event.target.value as Priority)}
                disabled={!canLaunch}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          )}

          {domains.length > 0 && (
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">
                Domain Pack <span className="text-gray-600">（领域人设 + 知识库注入，可选）</span>
              </label>
              <select
                value={domainId}
                onChange={event => setDomainId(event.target.value)}
                disabled={!canLaunch}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
              >
                <option value="">无 / 自动（按 agent 绑定）</option>
                {domains.map(domain => (
                  <option key={domain.id} value={domain.id}>
                    {domain.emoji} {domain.name}{domain.builtin ? '（示例）' : ''}
                  </option>
                ))}
              </select>
              {domainId && (
                <div className="text-[11px] text-gray-500 mt-1">
                  {mode === 'pipeline'
                    ? '流水线每个阶段任务都会继承该领域，注入人设与知识库。'
                    : '执行时将注入该领域的人设、准则与知识库检索结果。'}
                </div>
              )}
            </div>
          )}

          {mode === 'pipeline' && (
            <div className="grid md:grid-cols-[1fr_160px] gap-3">
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Template</label>
                <select
                  value={templateId}
                  onChange={event => setTemplateId(event.target.value)}
                  disabled={!canLaunch || templates.length === 0}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
                >
                  <option value="">Select template...</option>
                  {templates.map(template => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
                {selectedTemplate && (
                  <div className="mt-2 bg-background border border-border rounded-lg p-3">
                    <div className="text-xs font-medium">{selectedTemplate.name}</div>
                    {selectedTemplate.description && (
                      <div className="text-[11px] text-gray-500 mt-1">{selectedTemplate.description}</div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {selectedTemplate.stages.map(stage => (
                        <span key={`${stage.name}-${stage.role}`} className="px-2 py-0.5 rounded bg-surface-hover text-[10px] text-gray-500">
                          {stage.name} · {stage.role}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="text-[11px] text-gray-500 mb-1 block">Gate mode</label>
                <select
                  value={gateMode}
                  onChange={event => setGateMode(event.target.value as 'auto' | 'manual')}
                  disabled={!canLaunch}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
                >
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                </select>
                {gateMode === 'auto' && (
                  <label className="flex items-start gap-2 mt-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={confirmAutonomousPublish}
                      onChange={event => setConfirmAutonomousPublish(event.target.checked)}
                      disabled={!canLaunch}
                      className="mt-0.5"
                    />
                    <span>
                      <strong>Allow fully autonomous publish.</strong> Off by default — pipelines that can
                      reach a real publish tool (Xiaohongshu / Douyin MCP) stay on Manual Gates until you
                      check this, even if Auto is selected above.
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}

          {(validationError || error) && (
            <div className={cn(
              'border rounded-lg px-3 py-2 text-xs',
              error ? 'bg-red-500/10 border-red-500/20 text-red-400' : 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
            )}>
              {error || validationError}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
            <button
              onClick={() => void submit()}
              disabled={busy || !!validationError}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition disabled:opacity-50"
            >
              {busy ? 'Launching...' : mode === 'pipeline' ? 'Launch pipeline' : 'Create task'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
