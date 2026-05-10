import { useState } from 'react';
import { useStore } from '../stores/store';
import { api } from '../lib/api';
import { cn } from '../lib/utils';

const stageStatusIcons: Record<string, string> = {
  pending: '⏳', running: '🔄', review: '👁️', done: '✅', failed: '❌', skipped: '⏭️',
};

export function PipelinesPage() {
  const { pipelines, templates, loadPipelines } = useStore();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Pipelines</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition"
        >
          + New Pipeline
        </button>
      </div>

      {pipelines.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">🔗</div>
          <p>No pipelines yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pipelines.map(pipeline => (
            <PipelineCard
              key={pipeline.id}
              pipeline={pipeline}
              onApprove={() => { api.pipelines.approve(pipeline.id).then(loadPipelines); }}
              onSkip={() => { api.pipelines.skip(pipeline.id).then(loadPipelines); }}
              onCancel={() => { api.pipelines.cancel(pipeline.id).then(loadPipelines); }}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreatePipelineModal
          templates={templates}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadPipelines(); }}
        />
      )}
    </div>
  );
}

function PipelineCard({ pipeline, onApprove, onSkip, onCancel }: {
  pipeline: any; onApprove: () => void; onSkip: () => void; onCancel: () => void;
}) {
  const statusColor: Record<string, string> = {
    running: 'text-blue-400', paused: 'text-yellow-400', blocked: 'text-orange-400',
    done: 'text-green-400', failed: 'text-red-400',
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold">{pipeline.name}</h3>
          <span className={cn('text-xs', statusColor[pipeline.status])}>{pipeline.status}</span>
        </div>
        <div className="flex gap-2">
          {pipeline.status === 'paused' && (
            <>
              <button onClick={onApprove} className="px-3 py-1 bg-green-500/20 text-green-400 rounded-lg text-xs hover:bg-green-500/30">
                Approve
              </button>
              <button onClick={onSkip} className="px-3 py-1 bg-yellow-500/20 text-yellow-400 rounded-lg text-xs hover:bg-yellow-500/30">
                Skip
              </button>
            </>
          )}
          {['running', 'paused', 'blocked'].includes(pipeline.status) && (
            <button onClick={onCancel} className="px-3 py-1 bg-red-500/20 text-red-400 rounded-lg text-xs hover:bg-red-500/30">
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Stage Progress */}
      <div className="flex items-center gap-1">
        {pipeline.stages.map((stage: any, i: number) => (
          <div key={i} className="flex items-center gap-1">
            <div className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
              stage.status === 'done' ? 'bg-green-500/15 text-green-400' :
              stage.status === 'running' ? 'bg-blue-500/15 text-blue-400' :
              stage.status === 'failed' ? 'bg-red-500/15 text-red-400' :
              'bg-gray-500/10 text-gray-500'
            )}>
              <span>{stageStatusIcons[stage.status]}</span>
              {stage.name}
            </div>
            {i < pipeline.stages.length - 1 && <span className="text-gray-600 text-xs">→</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function CreatePipelineModal({ templates, onClose, onCreated }: { templates: any[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [input, setInput] = useState('');
  const [gateMode, setGateMode] = useState<'auto' | 'manual'>('auto');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!name || !templateId || !input) return;
    setLoading(true);
    try {
      await api.pipelines.create({ name, templateId, input, gateMode });
      onCreated();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-[500px] p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4">Create Pipeline</h3>
        <div className="space-y-4">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Pipeline name"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none" />

          <select value={templateId} onChange={e => setTemplateId(e.target.value)}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none">
            <option value="">Select template...</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>

          <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Describe what you want to build..."
            rows={4} className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none resize-none" />

          <div className="flex gap-2">
            <button onClick={() => setGateMode('auto')}
              className={cn('px-3 py-1.5 rounded-lg text-xs', gateMode === 'auto' ? 'bg-accent text-white' : 'bg-surface-hover text-gray-400')}>
              Auto
            </button>
            <button onClick={() => setGateMode('manual')}
              className={cn('px-3 py-1.5 rounded-lg text-xs', gateMode === 'manual' ? 'bg-accent text-white' : 'bg-surface-hover text-gray-400')}>
              Manual Gates
            </button>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400">Cancel</button>
            <button onClick={submit} disabled={loading || !name || !templateId || !input}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
