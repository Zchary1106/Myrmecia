import { v4 as uuid } from 'uuid';
import { getDb } from '../db/database.js';
import { eventBus } from '../events/event-bus.js';
import { TaskQueue } from '../queue/task-queue.js';
import { MasterAgent } from './master-agent.js';
import { listTasks, getTask } from '../db/models/task.js';
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

  constructor(private taskQueue: TaskQueue) {
    this.masterAgent = new MasterAgent(taskQueue);
    // Reflect task lifecycle onto the owning run.
    eventBus.on('task:done', (e: any) => this.onTaskSettled(e));
    eventBus.on('task:failed', (e: any) => this.onTaskSettled(e));
  }

  getRun(runId: string): TeamRun | undefined {
    const row = getDb().get('SELECT * FROM team_runs WHERE id = ?', runId) as any;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(teamId?: string, limit = 50): TeamRun[] {
    const db = getDb();
    const rows = (teamId
      ? db.all('SELECT * FROM team_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT ?', teamId, limit)
      : db.all('SELECT * FROM team_runs ORDER BY created_at DESC LIMIT ?', limit)) as any[];
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
}
