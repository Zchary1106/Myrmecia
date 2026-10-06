import { useEffect, useMemo, useState } from 'react';
import { api, type DomainPackDTO, type DomainPackInputDTO, type DomainUsageDTO } from '../lib/api';
import { useStore } from '../stores/store';
import { cn } from '../lib/utils';

const FRE_KEY = 'myrmecia.domains.fre.v1';

interface FormState {
  id?: string;
  name: string;
  emoji: string;
  persona: string;
  guidelines: string;      // one per line
  terminology: string;     // "key: value" per line
  disclaimer: string;
  tone: string;
  agentIds: string[];
  retrievalEnabled: boolean;
  topK: number;
  minScore: number;
}

const emptyForm: FormState = {
  name: '', emoji: '📘', persona: '', guidelines: '', terminology: '',
  disclaimer: '', tone: '', agentIds: [], retrievalEnabled: true, topK: 6, minScore: 0.35,
};

function toForm(d: DomainPackDTO): FormState {
  return {
    id: d.id,
    name: d.name,
    emoji: d.emoji,
    persona: d.persona,
    guidelines: d.guidelines.join('\n'),
    terminology: Object.entries(d.terminology || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    disclaimer: d.disclaimer || '',
    tone: d.tone || '',
    agentIds: [...d.agentIds],
    retrievalEnabled: d.retrieval.enabled,
    topK: d.retrieval.topK,
    minScore: d.retrieval.minScore,
  };
}

function toInput(f: FormState): DomainPackInputDTO {
  const terminology: Record<string, string> = {};
  for (const line of f.terminology.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) terminology[k] = v;
    }
  }
  return {
    name: f.name.trim(),
    emoji: f.emoji.trim() || '📘',
    persona: f.persona.trim(),
    guidelines: f.guidelines.split('\n').map(s => s.trim()).filter(Boolean),
    terminology,
    disclaimer: f.disclaimer.trim() || undefined,
    tone: f.tone.trim() || undefined,
    agentIds: f.agentIds,
    retrieval: { enabled: f.retrievalEnabled, topK: f.topK, minScore: f.minScore },
  };
}

export function DomainsPage() {
  const { agents, loadAgents } = useStore() as any;
  const [domains, setDomains] = useState<DomainPackDTO[]>([]);
  const [editing, setEditing] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [showWizard, setShowWizard] = useState(false);
  const [uploadFor, setUploadFor] = useState<DomainPackDTO | null>(null);
  const [usage, setUsage] = useState<Record<string, DomainUsageDTO>>({});

  const reload = () => {
    api.domains.list().then(setDomains).catch(e => setError(e.message));
    api.domains.usage().then(setUsage).catch(() => { /* usage optional */ });
  };

  useEffect(() => {
    if (!agents?.length) loadAgents?.();
    reload();
    if (!localStorage.getItem(FRE_KEY)) setShowWizard(true);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const example = useMemo(() => domains.find(d => d.builtin) || domains[0], [domains]);

  const save = async () => {
    if (!editing) return;
    setBusy(true); setError('');
    try {
      const input = toInput(editing);
      if (!input.name) throw new Error('请填写领域名称');
      if (!input.persona) throw new Error('请填写专家人设 Persona');
      if (editing.id) {
        await api.domains.update(editing.id, input);
        setToast('领域已更新');
      } else {
        await api.domains.create(input);
        setToast('领域已创建');
      }
      setEditing(null);
      await reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: DomainPackDTO) => {
    if (!confirm(`删除领域「${d.name}」？${d.builtin ? '（将恢复为内置示例）' : ''}`)) return;
    try {
      await api.domains.remove(d.id);
      setToast('已删除');
      await reload();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const copyFrom = (d: DomainPackDTO) => {
    const f = toForm(d);
    setEditing({ ...f, id: undefined, name: `${d.name} 副本` });
  };

  const finishWizard = (seed?: { name: string; persona: string }) => {
    localStorage.setItem(FRE_KEY, '1');
    setShowWizard(false);
    if (seed) setEditing({ ...emptyForm, name: seed.name, persona: seed.persona });
  };

  return (
    <div className="ui-page">
      <header className="ui-page-heading">
        <div>
          <div className="ui-eyebrow">Domain knowledge</div>
          <h1 className="ui-page-title">Domains</h1>
          <p className="ui-page-description">
            领域定制包 — 给 agent 装上你的行业人设与知识库。平台只附一个示例，其余由你定制。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowWizard(true)}
            className="ui-button"
          >
            ❓ 引导
          </button>
          <button
            onClick={() => setEditing({ ...emptyForm })}
            className="ui-button-primary"
          >
            ＋ 新建领域
          </button>
        </div>
      </header>

      {error && (
        <div className="flex justify-between rounded-xl border border-red-500/25 bg-red-500/[0.08] px-4 py-2.5 text-sm text-red-500">
          <span>{error}</span>
          <button onClick={() => setError('')} className="ui-button-quiet text-red-500" aria-label="Dismiss error">✕</button>
        </div>
      )}

      <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3', domains.length <= 1 && 'max-w-5xl xl:grid-cols-2')}>
        {domains.map(d => (
          <DomainCard
            key={d.id}
            domain={d}
            usage={usage[d.id]}
            onEdit={() => setEditing(toForm(d))}
            onCopy={() => copyFrom(d)}
            onDelete={() => remove(d)}
            onUpload={() => setUploadFor(d)}
          />
        ))}
        <button
          onClick={() => (example ? copyFrom(example) : setEditing({ ...emptyForm }))}
          className="app-focus grid min-h-[190px] place-items-center rounded-2xl border border-dashed border-border/80 bg-background/35 text-app-muted transition duration-200 hover:-translate-y-px hover:border-accent/45 hover:bg-accent/[0.035] hover:text-accent-light"
        >
          <div className="text-center">
            <div className="text-3xl mb-1">＋</div>
            <div className="text-sm">{example ? '从示例复制 / 全新创建' : '创建第一个领域'}</div>
          </div>
        </button>
      </div>

      {editing && (
        <DomainEditor
          form={editing}
          setForm={setEditing}
          agents={agents || []}
          busy={busy}
          onSave={save}
          onCancel={() => { setEditing(null); setError(''); }}
        />
      )}

      {uploadFor && (
        <KnowledgeUpload
          domain={uploadFor}
          onClose={() => setUploadFor(null)}
          onDone={(msg) => { setUploadFor(null); setToast(msg); reload(); }}
        />
      )}

      {showWizard && <FirstRunWizard onClose={finishWizard} hasExample={!!example} />}

      {toast && (
        <div className="message-enter fixed bottom-6 right-6 z-40 rounded-xl border border-emerald-500/25 bg-surface px-4 py-2.5 text-sm text-emerald-500 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function DomainCard({ domain, usage, onEdit, onCopy, onDelete, onUpload }: {
  domain: DomainPackDTO;
  usage?: DomainUsageDTO;
  onEdit: () => void; onCopy: () => void; onDelete: () => void; onUpload: () => void;
}) {
  const docCount = domain.documents?.length ?? domain.knowledgeIds.length;
  return (
    <article className="ui-panel-interactive relative min-h-[190px] p-5">
      <span className={cn(
        'absolute right-4 top-4 rounded-lg border px-2 py-1 text-[9px] font-semibold',
        domain.builtin
          ? 'border-amber-500/20 bg-amber-500/[0.08] text-amber-500'
          : 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-500',
      )}>
        {domain.builtin ? '示例' : '自定义'}
      </span>
      <div className="flex items-center gap-2.5">
        <div className="grid h-10 w-10 place-items-center rounded-xl border border-border/70 bg-background/65 text-lg">
          {domain.emoji}
        </div>
        <div className="min-w-0 pr-14">
          <h2 className="truncate text-sm font-semibold text-app-primary">{domain.name}</h2>
          <div className="truncate font-mono text-[10px] text-app-muted">{domain.id}</div>
        </div>
      </div>
      <p className="mt-3 min-h-[40px] line-clamp-2 text-xs leading-5 text-app-secondary">
        {domain.persona || '（未填写人设）'}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="ui-chip border-accent/20 bg-accent/[0.06] text-accent-light">
          📄 {docCount} 知识库
        </span>
        {domain.agentIds.slice(0, 3).map(a => (
          <span key={a} className="ui-chip">
            🤖 {a}
          </span>
        ))}
        {domain.disclaimer && (
          <span className="ui-chip">
            ⚠ 免责声明
          </span>
        )}
        {domain.retrieval.enabled && (
          <span className="ui-chip">
            🔎 topK {domain.retrieval.topK}
          </span>
        )}
      </div>
      {usage && usage.taskCount > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/70 pt-3 text-[10px] text-app-muted">
          <span title="该领域累计花费">💰 {usage.costUSD == null ? 'N/A' : `$${usage.costUSD.toFixed(3)}`}</span>
          <span title="任务数">📋 {usage.taskCount} 任务</span>
          <span title="累计 tokens">🔢 {formatTokens(usage.tokens)} tokens</span>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-1.5">
        <button onClick={onEdit} className="ui-button-quiet">编辑</button>
        <button onClick={onUpload} className="ui-button-quiet">＋ 知识库</button>
        <button onClick={onCopy} className="ui-button-quiet">复制</button>
        <button onClick={onDelete} className="ui-button-quiet ml-auto hover:bg-red-500/[0.08] hover:text-red-500">删除</button>
      </div>
    </article>
  );
}

function DomainEditor({ form, setForm, agents, busy, onSave, onCancel }: {
  form: FormState;
  setForm: (f: FormState) => void;
  agents: Array<{ id: string; name: string; emoji?: string }>;
  busy: boolean;
  onSave: () => void; onCancel: () => void;
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const toggleAgent = (id: string) =>
    set('agentIds', form.agentIds.includes(id) ? form.agentIds.filter(a => a !== id) : [...form.agentIds, id]);

  return (
    <Modal onClose={onCancel} title={form.id ? '编辑领域' : '新建领域'} wide>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="领域名称">
            <input className={inputCls} value={form.name} onChange={e => set('name', e.target.value)} placeholder="如：合同审查助手" />
          </Field>
          <Field label="Emoji">
            <input className={inputCls} value={form.emoji} onChange={e => set('emoji', e.target.value)} maxLength={4} />
          </Field>
          <Field label="专家人设 Persona *">
            <textarea className={cn(inputCls, 'min-h-[120px]')} value={form.persona} onChange={e => set('persona', e.target.value)}
              placeholder="你是一位资深……，严格依据知识库作答，引用来源……" />
          </Field>
          <Field label="语气 Tone">
            <input className={inputCls} value={form.tone} onChange={e => set('tone', e.target.value)} placeholder="严谨 · 专业 · 可引用" />
          </Field>
        </div>

        <div className="space-y-3">
          <Field label="作答准则 Guidelines（每行一条）">
            <textarea className={cn(inputCls, 'min-h-[88px]')} value={form.guidelines} onChange={e => set('guidelines', e.target.value)}
              placeholder={'先检索知识库再作答\n标注引用来源\n资料缺失时明确说明'} />
          </Field>
          <Field label="术语 Terminology（每行 key: value）">
            <textarea className={cn(inputCls, 'min-h-[60px]')} value={form.terminology} onChange={e => set('terminology', e.target.value)}
              placeholder={'SLA: 服务等级协议'} />
          </Field>
          <Field label="强制免责声明 Disclaimer">
            <input className={inputCls} value={form.disclaimer} onChange={e => set('disclaimer', e.target.value)}
              placeholder="本回答仅供参考，不构成专业意见。" />
          </Field>
          <Field label="启用的 Agent">
            <div className="flex flex-wrap gap-1.5">
              {agents.length === 0 && <span className="text-xs text-app-muted">无可用 agent</span>}
              {agents.map(a => (
                <button type="button" key={a.id} onClick={() => toggleAgent(a.id)}
                  className={cn(
                    'app-focus rounded-lg border px-2.5 py-1.5 text-xs transition',
                    form.agentIds.includes(a.id)
                      ? 'border-accent/35 bg-accent/[0.09] text-accent-light'
                      : 'border-border/70 bg-background/55 text-app-secondary hover:border-accent/25 hover:bg-surface-hover hover:text-app-primary',
                  )}>
                  {a.emoji || '🤖'} {a.id}
                </button>
              ))}
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-app-secondary">
              <input type="checkbox" checked={form.retrievalEnabled} onChange={e => set('retrievalEnabled', e.target.checked)} />
              检索增强（自动注入知识库）
            </label>
            <label className="flex items-center gap-1.5 text-xs text-app-secondary">
              topK
              <input type="number" min={1} max={20} value={form.topK} onChange={e => set('topK', Number(e.target.value))}
                className="ui-field w-16 px-2 py-1.5 text-xs" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-app-secondary">
              minScore
              <input type="number" min={0} max={1} step={0.05} value={form.minScore} onChange={e => set('minScore', Number(e.target.value))}
                className="ui-field w-20 px-2 py-1.5 text-xs" />
            </label>
          </div>
        </div>
      </div>

      <div className="mt-6 flex gap-2">
        <button onClick={onSave} disabled={busy}
          className="ui-button-primary">
          {busy ? '保存中…' : '保存领域'}
        </button>
        <button onClick={onCancel} className="ui-button">
          取消
        </button>
      </div>
    </Modal>
  );
}

function KnowledgeUpload({ domain, onClose, onDone }: {
  domain: DomainPackDTO; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const upload = async () => {
    if (!title.trim() || !content.trim()) { setErr('请填写标题与内容'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.domains.uploadKnowledge(domain.id, { title: title.trim(), content });
      onDone(`已上传「${r.document.title}」（${r.document.chunkCount} 片段）`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`上传知识库 → ${domain.emoji} ${domain.name}`}>
      <p className="mb-4 text-xs leading-5 text-app-muted">
        粘贴文档内容（法规、手册、规范、FAQ…）。系统会自动分块、向量化，并绑定到该领域，执行时检索注入。
      </p>
      {err && <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">{err}</div>}
      <Field label="文档标题">
        <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="如：标准服务合同模板 v3" />
      </Field>
      <Field label="文档内容">
        <textarea className={cn(inputCls, 'min-h-[200px] font-mono text-xs')} value={content} onChange={e => setContent(e.target.value)}
          placeholder="在此粘贴文档全文…" />
      </Field>
      <div className="mt-5 flex gap-2">
        <button onClick={upload} disabled={busy}
          className="ui-button-primary">
          {busy ? '上传中…' : '上传并绑定'}
        </button>
        <button onClick={onClose} className="ui-button">
          取消
        </button>
      </div>
    </Modal>
  );
}

const WIZARD_STEPS = [
  {
    emoji: '👋', title: '欢迎使用 Domain Packs',
    body: '领域包让通用 agent 变成「你的行业专家」：定义人设与规则、上传你的知识库、绑定 agent，执行任务时自动注入。平台不预置领域，只给一个示例——其余完全由你定制。',
  },
  {
    emoji: '🧩', title: '第 1 步 · 定义人设 Persona',
    body: 'Persona 是领域专家的身份与作答风格，会注入到 system prompt 顶部。配合「作答准则」（先检索、标引用、不超纲）和「免责声明」，约束 agent 的行为边界。',
  },
  {
    emoji: '📚', title: '第 2 步 · 上传知识库',
    body: '把你的法规 / 手册 / 论文 / 内部规范粘贴进来，系统自动分块并向量化，绑定到该领域。执行时按问题检索 top-K 片段注入上下文——回答基于「你的资料」而非模型臆测。',
  },
  {
    emoji: '🤖', title: '第 3 步 · 绑定 Agent',
    body: '选择哪些 agent（dev / review / 你自建的）在该领域工作。绑定后，这些 agent 处理任务时会自动带上领域人设与知识；也可在创建任务时显式指定领域。',
  },
  {
    emoji: '🚀', title: '开始创建你的第一个领域',
    body: '给领域起个名字、写一句人设，马上开始。你随时可以点右上角「引导」重看本教程。',
  },
];

function FirstRunWizard({ onClose, hasExample }: { onClose: (seed?: { name: string; persona: string }) => void; hasExample: boolean }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const last = step === WIZARD_STEPS.length - 1;
  const s = WIZARD_STEPS[step];

  return (
    <Modal onClose={() => onClose()} title="" bare>
      <div className="text-center px-2 py-1">
        <div className="text-5xl mb-3">{s.emoji}</div>
        <h3 className="text-xl font-bold mb-2">{s.title}</h3>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-app-secondary">{s.body}</p>

        {last && (
          <div className="mt-5 space-y-2.5 text-left max-w-md mx-auto">
            <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="领域名称（如：合同审查助手）" />
            <textarea className={cn(inputCls, 'min-h-[72px]')} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="一句话人设：你是一位资深……，严格依据知识库作答。" />
          </div>
        )}

        <div className="flex items-center justify-center gap-1.5 mt-5">
          {WIZARD_STEPS.map((_, i) => (
            <span key={i} className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-6 bg-accent' : 'w-1.5 bg-border')} />
          ))}
        </div>

        <div className="flex gap-2 justify-center mt-5">
          {step > 0 && (
            <button onClick={() => setStep(step - 1)} className="ui-button">
              上一步
            </button>
          )}
          {!last ? (
            <>
              <button onClick={() => onClose()} className="ui-button-quiet">跳过</button>
              <button onClick={() => setStep(step + 1)} className="ui-button-primary">
                下一步
              </button>
            </>
          ) : (
            <>
              <button onClick={() => onClose()} className="ui-button">
                稍后再说
              </button>
              <button
                onClick={() => onClose(name.trim() && persona.trim() ? { name: name.trim(), persona: persona.trim() } : undefined)}
                className="ui-button-primary">
                {name.trim() ? '创建领域' : (hasExample ? '去看示例' : '开始')}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------- shared UI bits ----------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const inputCls = 'ui-field';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="ui-label">{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose, wide, bare }: {
  title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; bare?: boolean;
}) {
  return (
    <div className="ui-dialog-backdrop" onClick={onClose}>
      <div
        className={cn('ui-dialog', wide ? 'max-w-3xl' : 'max-w-lg')}
        onClick={e => e.stopPropagation()}
      >
        {!bare && (
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold tracking-[-0.02em] text-app-primary">{title}</h3>
            <button onClick={onClose} className="ui-button-quiet h-8 w-8 px-0 text-lg" aria-label="Close dialog">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
