import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { MasterAgent } from './master-agent.js';
import { messageBus } from './message-bus.js';
import { listTasks, getTask } from '../db/models/task.js';
import { listExecutions } from '../db/models/execution.js';
import { getTeam, resolveTeamAgents, type Team } from './team-registry.js';
import type { Task } from '../types.js';

export interface TeamRun {
  id: string;
  teamId: string;
  goal: string;
  status: 'planning' | 'running' | 'done' | 'failed';
  parentTaskId?: string;
  result?: string;
  workspaceId: string;
  createdAt: string;
  completedAt?: string;
}

function rowToRun(row: any): TeamRun {
  return {
    id: row.id,
    teamId: row.team_id,
    goal: row.goal,
    status: row.status,
    parentTaskId: row.parent_task_id || undefined,
    result: row.result || undefined,
    workspaceId: row.workspace_id || 'default',
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined,
  };
}

/** A single teammate's card on the shared board. */
export interface BoardItem {
  taskId: string;
  title: string;
  role: string | null;
  assigneeId: string | null;
  status: string;
  dependsOn: string[];
  output?: string;
}

export class TeamCoordinator {
  private masterAgent: MasterAgent;
  private shared = new Set<string>(); // taskIds whose finding was already broadcast

  constructor(private taskQueue: TaskQueue) {
    this.masterAgent = new MasterAgent(taskQueue);
    // Reflect task lifecycle onto the owning run + share findings across teammates.
    eventBus.on('task:done', (e: any) => { this.shareFinding(e); this.onTaskSettled(e); });
    eventBus.on('task:failed', (e: any) => this.onTaskSettled(e));
  }

  getRun(runId: string): TeamRun | undefined {
    const row = getDb().get('SELECT * FROM team_runs WHERE id = ?', runId) as any;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(teamId?: string, workspaceId?: string, limit = 50): TeamRun[] {
    const db = getDb();
    const conditions: string[] = [];
    const params: any[] = [];
    if (teamId) { conditions.push('team_id = ?'); params.push(teamId); }
    if (workspaceId) { conditions.push('workspace_id = ?'); params.push(workspaceId); }
    let sql = 'SELECT * FROM team_runs';
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = db.all(sql, ...params) as any[];
    return rows.map(rowToRun);
  }

  /** The shared task board for a run (the run's parent task children). */
  board(runId: string): BoardItem[] {
    const run = this.getRun(runId);
    if (!run?.parentTaskId) return [];
    const children = listTasks({ parentTaskId: run.parentTaskId });
    return children.map(t => ({
      taskId: t.id,
      title: t.title,
      role: t.assigneeId || null,
      assigneeId: t.assigneeId || null,
      status: t.status,
      dependsOn: t.dependsOn || [],
      output: t.output || undefined,
    }));
  }

  /** Dispatch a goal to a team: the lead decomposes it across the roster and the
   *  members run in parallel. Returns immediately with the run + initial board. */
  async dispatch(teamId: string, goal: string, workspaceId = 'default'): Promise<{ run: TeamRun; team: Team; board: BoardItem[] }> {
    const team = getTeam(teamId);
    if (!team) throw new Error(`Unknown team: ${teamId}`);
    if (!goal || !goal.trim()) throw new Error('goal is required');

    const roster = resolveTeamAgents(team);
    if (roster.length === 0) throw new Error(`Team "${team.name}" has no resolvable members`);

    const id = `trun_${uuid().slice(0, 8)}`;
    const db = getDb();
    db.run(
      'INSERT INTO team_runs (id, team_id, goal, status, workspace_id) VALUES (?, ?, ?, ?, ?)',
      id, team.id, goal, 'planning', workspaceId,
    );
    eventBus.emit('team:run_created', { runId: id, teamId: team.id, goal, workspaceId });

    // Parent task that owns the shared board.
    const parent = await this.taskQueue.enqueue({
      title: `${team.name}: ${goal.slice(0, 60)}`,
      description: goal,
      mode: 'master',
      input: goal,
      priority: 'normal',
      workspaceId,
    });
    db.run('UPDATE team_runs SET parent_task_id = ?, status = ? WHERE id = ?', parent.id, 'running', id);

    // Decompose constrained to the team's roles, then run members in parallel.
    const allowedRoles = team.members;
    this.masterAgent.decompose(parent, { allowedRoles, teamName: team.name })
      .then(subtasks => {
        eventBus.emit('team:run_planned', { runId: id, teamId: team.id, taskIds: subtasks.map(s => s.id), workspaceId });
      })
      .catch(err => {
        db.run('UPDATE team_runs SET status = ?, result = ?, completed_at = ? WHERE id = ?',
          'failed', String(err?.message || err), new Date().toISOString(), id);
        eventBus.emit('team:run_failed', { runId: id, teamId: team.id, error: String(err?.message || err), workspaceId });
      });

    const run = this.getRun(id)!;
    return { run, team, board: this.board(id) };
  }

  /** When any task settles, see if it belongs to a run's board and, if the whole
   *  board is finished, mark the run done. */
  private onTaskSettled(event: any): void {
    const taskId = event?.taskId || event?.payload?.taskId;
    if (!taskId) return;
    const task = getTask(taskId);
    const parentId = task?.parentTaskId || taskId;

    const db = getDb();
    const row = db.get('SELECT * FROM team_runs WHERE parent_task_id = ? AND status = ?', parentId, 'running') as any;
    if (!row) return;
    const run = rowToRun(row);

    const children = listTasks({ parentTaskId: parentId });
    if (children.length === 0) return; // not decomposed yet
    const allDone = children.every(t => ['done', 'failed', 'cancelled'].includes(t.status));
    if (!allDone) return;

    const anyFailed = children.some(t => t.status === 'failed');
    const result = children.map(t => `## ${t.title}\n${(t.output || '(no output)').slice(0, 4000)}`).join('\n\n---\n\n');
    db.run('UPDATE team_runs SET status = ?, result = ?, completed_at = ? WHERE id = ?',
      anyFailed ? 'failed' : 'done', result, new Date().toISOString(), run.id);
    eventBus.emit('team:run_done', { runId: run.id, teamId: run.teamId, status: anyFailed ? 'failed' : 'done', workspaceId: run.workspaceId });
  }

  /** Inter-team comms: when a teammate finishes, share a short summary of its
   *  finding with the other still-running teammates so they can build on it. */
  private shareFinding(event: any): void {
    const taskId = event?.taskId || event?.payload?.taskId;
    if (!taskId || this.shared.has(taskId)) return;
    const task = getTask(taskId);
    if (!task?.parentTaskId) return;
    // Only for tasks that belong to an active team run.
    const row = getDb().get('SELECT * FROM team_runs WHERE parent_task_id = ? AND status = ?', task.parentTaskId, 'running') as any;
    if (!row) return;
    this.shared.add(taskId);

    const summary = (event?.output || task.output || '').toString().replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!summary) return;
    const siblings = listTasks({ parentTaskId: task.parentTaskId })
      .filter(t => t.id !== taskId && ['running', 'assigned', 'pending', 'queued'].includes(t.status));
    let delivered = 0;
    for (const sib of siblings) {
      const exec = listExecutions({ taskId: sib.id, limit: 1 })[0];
      if (!exec) continue; // not started yet — it'll get predecessor context via deps
      messageBus.send(null, exec.id, 'context_update',
        `Teammate "${task.title}" finished. Key result: ${summary}`);
      delivered++;
    }
    if (delivered > 0) {
      eventBus.emit('team:run_planned', { runId: row.id, teamId: row.team_id, shared: { from: task.title, to: delivered }, workspaceId: row.workspace_id });
    }
  }

  /**
   * Direct-message (or redirect) a specific teammate in a run.
   * `target` is a taskId, an agentId, a role, or 'all'. When `redirect` is set
   * and the teammate already finished, a fresh follow-up task is spawned for
   * that agent with the new instruction (so it re-engages).
   */
  async messageTeammate(runId: string, target: string, content: string, opts?: { redirect?: boolean }): Promise<{
    delivered: { taskId: string; agentId: string | null; live: boolean }[];
    redirected: string[];
  }> {
    const run = this.getRun(runId);
    if (!run?.parentTaskId) throw new Error('run not found or not planned yet');
    if (!content?.trim()) throw new Error('message content is required');

    const children = listTasks({ parentTaskId: run.parentTaskId });
    const key = (target || 'all').toLowerCase();
    const matches = key === 'all' ? children : children.filter(t =>
      t.id === target || (t.assigneeId || '').toLowerCase() === key);
    if (matches.length === 0) throw new Error(`no teammate matches "${target}"`);

    const delivered: { taskId: string; agentId: string | null; live: boolean }[] = [];
    const redirected: string[] = [];

    for (const t of matches) {
      const running = listExecutions({ taskId: t.id, limit: 1 }).find(e => e.status === 'running');
      if (running) {
        messageBus.send(null, running.id, 'task_handoff', `Message from the team lead: ${content}`);
        delivered.push({ taskId: t.id, agentId: t.assigneeId || null, live: true });
        continue;
      }
      if (opts?.redirect && ['done', 'failed', 'cancelled'].includes(t.status)) {
        const follow = await this.taskQueue.enqueue({
          title: `Follow-up: ${t.title}`.slice(0, 80),
          description: content,
          mode: 'master',
          input: content,
          assigneeId: t.assigneeId || undefined,
          parentTaskId: run.parentTaskId,
          workspaceId: run.workspaceId,
        });
        // Re-open the run so the new task is tracked to completion.
        getDb().run("UPDATE team_runs SET status = 'running', completed_at = NULL WHERE id = ? AND status != 'running'", run.id);
        redirected.push(follow.id);
      } else {
        // Not running and not redirecting — queue it for whenever it next runs.
        const exec = listExecutions({ taskId: t.id, limit: 1 })[0];
        if (exec) { messageBus.send(null, exec.id, 'task_handoff', `Message from the team lead: ${content}`); delivered.push({ taskId: t.id, agentId: t.assigneeId || null, live: false }); }
      }
    }
    eventBus.emit('team:run_planned', { runId: run.id, teamId: run.teamId, message: { target, delivered: delivered.length, redirected: redirected.length }, workspaceId: run.workspaceId });
    return { delivered, redirected };
  }
}
