import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import type { LogEntry } from '@agent-factory/shared';

interface StepState {
  index: number;
  total: number;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  retries?: number;
  error?: string;
  startedAt?: number;
  durationMs?: number;
}

interface SkillStepProgressProps {
  taskId: string;
  className?: string;
}

const STEP_STARTED_RE = /▶ Step (\d+)\/(\d+): (.+)/;
const STEP_DONE_RE = /✓ Step "(.+)" done/;
const STEP_FAILED_RE = /✗ Step "(.+)" failed: (.+)/;
const SKILL_EXECUTOR_RE = /Skill Executor: (\d+) steps/;
const RETRY_RE = /retry (\d+)/i;

function parseStepsFromLogs(logs: LogEntry[]): StepState[] {
  const steps = new Map<string, StepState>();
  let totalSteps = 0;

  for (const log of logs) {
    const msg = log.message;

    const executorMatch = msg.match(SKILL_EXECUTOR_RE);
    if (executorMatch) {
      totalSteps = parseInt(executorMatch[1], 10);
      continue;
    }

    const startedMatch = msg.match(STEP_STARTED_RE);
    if (startedMatch) {
      const [, indexStr, totalStr, name] = startedMatch;
      const index = parseInt(indexStr, 10);
      totalSteps = parseInt(totalStr, 10);
      steps.set(name, {
        index,
        total: totalSteps,
        name,
        status: 'running',
        startedAt: Date.now(),
      });
      continue;
    }

    const doneMatch = msg.match(STEP_DONE_RE);
    if (doneMatch) {
      const name = doneMatch[1];
      const existing = steps.get(name);
      if (existing) {
        existing.status = 'done';
        if (existing.startedAt) {
          existing.durationMs = Date.now() - existing.startedAt;
        }
      }
      continue;
    }

    const failedMatch = msg.match(STEP_FAILED_RE);
    if (failedMatch) {
      const [, name, error] = failedMatch;
      const existing = steps.get(name);
      if (existing) {
        existing.status = 'failed';
        existing.error = error;
        const retryMatch = error.match(RETRY_RE);
        if (retryMatch) existing.retries = parseInt(retryMatch[1], 10);
      }
      continue;
    }
  }

  // Build ordered array — fill in pending steps
  const result: StepState[] = [];
  const stepsArray = Array.from(steps.values()).sort((a, b) => a.index - b.index);

  for (const step of stepsArray) {
    result.push(step);
  }

  // Add pending placeholders if we know total
  if (totalSteps > result.length) {
    for (let i = result.length + 1; i <= totalSteps; i++) {
      result.push({ index: i, total: totalSteps, name: `Step ${i}`, status: 'pending' });
    }
  }

  return result;
}

function StepIcon({ status }: { status: StepState['status'] }) {
  switch (status) {
    case 'done':
      return <span className="text-green-400">✓</span>;
    case 'running':
      return (
        <span className="inline-block w-3.5 h-3.5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
      );
    case 'failed':
      return <span className="text-red-400">✗</span>;
    case 'pending':
    default:
      return <span className="text-gray-600">○</span>;
  }
}

export function SkillStepProgress({ taskId, className }: SkillStepProgressProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    const fetchLogs = async () => {
      try {
        const result = await api.tasks.logs(taskId);
        if (active) {
          setLogs(result);
          // Check if this is a skill executor task
          const hasSkillExecutor = result.some(l => SKILL_EXECUTOR_RE.test(l.message));
          setVisible(hasSkillExecutor);
        }
      } catch {}
    };
    fetchLogs();
    // Poll every 2s for running tasks
    const interval = setInterval(fetchLogs, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [taskId]);

  const steps = useMemo(() => parseStepsFromLogs(logs), [logs]);

  if (!visible || steps.length === 0) return null;

  const totalSteps = steps[0]?.total || steps.length;
  const completedSteps = steps.filter(s => s.status === 'done').length;

  return (
    <section className={cn('rounded-xl border border-border bg-surface p-4', className)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">🔧</span>
          <span className="text-xs font-semibold text-gray-300">Skill Executor</span>
        </div>
        <span className="text-[10px] text-gray-500">
          {completedSteps}/{totalSteps} steps
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-gray-700 mb-4 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
        />
      </div>

      {/* Step list */}
      <div className="space-y-2">
        {steps.map((step) => (
          <div
            key={step.index}
            className={cn(
              'flex items-start gap-3 rounded-lg px-3 py-2 transition',
              step.status === 'running' && 'bg-blue-500/5 border border-blue-500/20',
              step.status === 'failed' && 'bg-red-500/5 border border-red-500/20',
              step.status === 'done' && 'border border-transparent',
              step.status === 'pending' && 'border border-transparent opacity-50',
            )}
          >
            <div className="mt-0.5 w-4 flex-shrink-0 flex items-center justify-center">
              <StepIcon status={step.status} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={cn(
                  'text-xs font-medium truncate',
                  step.status === 'done' && 'text-gray-400',
                  step.status === 'running' && 'text-blue-300',
                  step.status === 'failed' && 'text-red-300',
                  step.status === 'pending' && 'text-gray-600',
                )}>
                  {step.name}
                </span>
                {step.durationMs && (
                  <span className="text-[10px] text-gray-600 flex-shrink-0">
                    {(step.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
                {step.status === 'running' && (
                  <span className="text-[10px] text-blue-400 flex-shrink-0">running</span>
                )}
              </div>
              {step.error && (
                <div className="mt-1 text-[10px] text-red-400/80 truncate">
                  {step.retries != null && `Retry ${step.retries} — `}{step.error}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
