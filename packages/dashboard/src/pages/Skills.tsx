import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { SkillDetail, SkillVersion } from '@agent-factory/shared';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useStore } from '../stores/store';
import { AuditDrawer } from '../components/audit/AuditDrawer';

const statusClass: Record<SkillVersion['status'], string> = {
  draft: 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300',
  published: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300',
  archived: 'border-gray-500/20 bg-gray-500/10 text-gray-400',
};

function diffLines(base: string, next: string) {
  const baseLines = base.split('\n');
  const nextLines = next.split('\n');
  const max = Math.max(baseLines.length, nextLines.length);
  const lines: { type: 'same' | 'add' | 'remove'; text: string }[] = [];
  for (let i = 0; i < max; i++) {
    if (baseLines[i] === nextLines[i]) {
      if (baseLines[i] !== undefined) lines.push({ type: 'same', text: `  ${baseLines[i]}` });
      continue;
    }
    if (baseLines[i] !== undefined) lines.push({ type: 'remove', text: `- ${baseLines[i]}` });
    if (nextLines[i] !== undefined) lines.push({ type: 'add', text: `+ ${nextLines[i]}` });
  }
  return lines.slice(0, 120);
}

export function SkillsPage() {
  const {
    skills,
    skillAssignments,
    agents,
    loadSkills,
    loadSkillAssignments,
    loadAgents,
  } = useStore();
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [changelog, setChangelog] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([loadSkills(), loadSkillAssignments(), loadAgents()]);
  }, []);

  useEffect(() => {
    if (!selectedSkillId && skills.length > 0) setSelectedSkillId(skills[0].id);
  }, [skills, selectedSkillId]);

  useEffect(() => {
    if (!selectedSkillId) return;
    api.skills.get(selectedSkillId)
      .then(next => {
        setDetail(next);
        const current = next.versions.find(version => version.id === next.publishedVersionId) || next.versions[0];
        setSelectedVersionId(current?.id || null);
        setEditorContent(current?.content || '');
        setChangelog('');
      })
      .catch((err: any) => setError(err.message || 'Load skill failed'));
  }, [selectedSkillId]);

  const selectedVersion = useMemo(
    () => detail?.versions.find(version => version.id === selectedVersionId),
    [detail, selectedVersionId],
  );
  const publishedVersions = useMemo(
    () => detail?.versions.filter(version => version.status === 'published') || [],
    [detail],
  );
  const baseline = useMemo(() => {
    const version = detail?.versions.find(item => item.id === detail.publishedVersionId) || detail?.versions[0];
    return version?.content || '';
  }, [detail]);
  const assignmentByAgent = useMemo(() => {
    return new Map(skillAssignments.map(assignment => [assignment.agentId, assignment]));
  }, [skillAssignments]);

  const refreshDetail = async () => {
    if (!selectedSkillId) return;
    const next = await api.skills.get(selectedSkillId);
    setDetail(next);
    await Promise.all([loadSkills(), loadSkillAssignments()]);
  };

  const runAction = async (action: () => Promise<unknown>) => {
    setError('');
    setSaving(true);
    try {
      await action();
      await refreshDetail();
    } catch (err: any) {
      setError(err.message || 'Skill operation failed');
    } finally {
      setSaving(false);
    }
  };

  const selectVersion = (version: SkillVersion) => {
    setSelectedVersionId(version.id);
    setEditorContent(version.content);
    setChangelog(version.changelog || '');
  };

  const createDraft = () => runAction(async () => {
    if (!detail) return;
    const version = await api.skills.createVersion(detail.id, {
      content: editorContent,
      changelog,
      status: 'draft',
    });
    setSelectedVersionId(version.id);
  });

  const updateDraft = () => {
    if (!selectedVersion) return;
    void runAction(() => api.skills.updateVersion(selectedVersion.id, { content: editorContent, changelog }));
  };

  const publishVersion = () => {
    if (!selectedVersion) return;
    void runAction(() => api.skills.publishVersion(selectedVersion.id));
  };

  const archiveVersion = () => {
    if (!selectedVersion) return;
    void runAction(() => api.skills.archiveVersion(selectedVersion.id));
  };

  const assignVersion = () => {
    if (!agentId || !selectedVersion) return;
    void runAction(() => api.skills.assign(agentId, selectedVersion.id));
  };

  const diff = useMemo(() => diffLines(baseline, editorContent), [baseline, editorContent]);

  return (
    <div className="p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-gradient-to-br from-surface to-background p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-accent-light">Skill Versioning</div>
            <h2 className="mt-2 text-3xl font-bold">Skill Registry</h2>
            <p className="mt-2 max-w-2xl text-sm text-gray-400">
              管理 Agent 的 Markdown skill prompt、版本发布、回滚和 Agent 绑定。每次执行都会记录实际使用的 skill version。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <AuditDrawer targetType="skill" targetId={selectedSkillId || undefined} label="Audit" />
            <button
              onClick={() => Promise.all([loadSkills(), loadSkillAssignments()])}
              className="rounded-xl bg-surface-hover px-4 py-2 text-sm text-gray-300 hover:text-white"
            >
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Skills" value={skills.length} />
          <Metric label="Published versions" value={skills.filter(skill => skill.publishedVersionId).length} tone="green" />
          <Metric label="Assignments" value={skillAssignments.length} tone="blue" />
          <Metric label="Agents" value={agents.length} />
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      <div className="grid gap-4 xl:grid-cols-[280px_1fr_360px]">
        <aside className="rounded-2xl border border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-gray-300">Skills</h3>
          <div className="mt-4 space-y-2">
            {skills.map(skill => (
              <button
                key={skill.id}
                onClick={() => setSelectedSkillId(skill.id)}
                className={cn(
                  'w-full rounded-lg border p-3 text-left transition',
                  selectedSkillId === skill.id ? 'border-accent/50 bg-accent/10' : 'border-border bg-background hover:border-accent/30',
                )}
              >
                <div className="truncate text-sm font-semibold">{skill.name}</div>
                <div className="mt-1 truncate text-[11px] text-gray-500">{skill.sourcePath || skill.id}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="space-y-4">
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">{detail?.name || 'Select a skill'}</h3>
                <div className="mt-1 text-xs text-gray-500">{detail?.description || 'No skill selected'}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button disabled={saving || !detail} onClick={createDraft} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  Save as draft
                </button>
                <button disabled={saving || selectedVersion?.status !== 'draft'} onClick={updateDraft} className="rounded-lg bg-surface-hover px-3 py-2 text-xs text-gray-300 disabled:opacity-50">
                  Update draft
                </button>
                <button disabled={saving || !selectedVersion || selectedVersion.status === 'archived'} onClick={publishVersion} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
                  Publish
                </button>
                <button disabled={saving || !selectedVersion || selectedVersion.status === 'archived'} onClick={archiveVersion} className="rounded-lg bg-red-500/20 px-3 py-2 text-xs text-red-200 disabled:opacity-50">
                  Archive
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[220px_1fr]">
              <div className="space-y-2">
                {detail?.versions.map(version => (
                  <button
                    key={version.id}
                    onClick={() => selectVersion(version)}
                    className={cn(
                      'w-full rounded-lg border p-3 text-left',
                      selectedVersionId === version.id ? 'border-accent/50 bg-accent/10' : 'border-border bg-background',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">v{version.version}</span>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[10px]', statusClass[version.status])}>{version.status}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-gray-500">{version.checksum.slice(0, 12)}</div>
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                <input
                  value={changelog}
                  onChange={event => setChangelog(event.target.value)}
                  placeholder="Changelog for this version"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <textarea
                  value={editorContent}
                  onChange={event => setEditorContent(event.target.value)}
                  rows={18}
                  spellCheck={false}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Markdown Preview">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-gray-300">{editorContent || 'No content'}</pre>
            </Panel>
            <Panel title="Diff vs current published">
              <pre className="max-h-80 overflow-auto text-xs leading-relaxed">
                {diff.map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      line.type === 'add' && 'text-emerald-300',
                      line.type === 'remove' && 'text-red-300',
                      line.type === 'same' && 'text-gray-500',
                    )}
                  >
                    {line.text}
                  </div>
                ))}
              </pre>
            </Panel>
          </div>
        </main>

        <aside className="rounded-2xl border border-border bg-surface p-4">
          <h3 className="text-sm font-semibold text-gray-300">Assign / Rollback</h3>
          <p className="mt-2 text-xs text-gray-500">选择 Agent，再选择任意 published version，即可把 Agent 回滚或升级到该 skill 版本。</p>
          <div className="mt-4 space-y-3">
            <select
              value={agentId}
              onChange={event => setAgentId(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Select agent</option>
              {agents.map(agent => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <select
              value={selectedVersionId || ''}
              onChange={event => {
                const version = detail?.versions.find(item => item.id === event.target.value);
                if (version) selectVersion(version);
              }}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {publishedVersions.map(version => (
                <option key={version.id} value={version.id}>v{version.version} · {version.checksum.slice(0, 8)}</option>
              ))}
            </select>
            <button
              disabled={saving || !agentId || selectedVersion?.status !== 'published'}
              onClick={assignVersion}
              className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Assign selected version
            </button>
          </div>

          <div className="mt-6 space-y-2">
            <h4 className="text-xs font-semibold text-gray-400">Current assignments</h4>
            {agents.map(agent => {
              const assignment = assignmentByAgent.get(agent.id);
              return (
                <div key={agent.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="truncate text-xs font-semibold">{agent.name}</div>
                  <div className="mt-1 truncate text-[10px] text-gray-500">{assignment?.skillVersionId || 'unassigned'}</div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-300">{title}</h3>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'green' | 'blue';
}) {
  const toneClass = {
    default: 'text-gray-100',
    green: 'text-emerald-300',
    blue: 'text-blue-300',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-background/70 p-4">
      <div className={cn('text-2xl font-bold', toneClass)}>{value}</div>
      <div className="mt-1 text-[10px] text-gray-500">{label}</div>
    </div>
  );
}
