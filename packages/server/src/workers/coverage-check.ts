import { execSync } from 'child_process';
import { eventBus } from '../events/event-bus.js';
import { getTask } from '../db/models/task.js';
import { createCoverageReport } from '../db/models/coverage-report.js';
import { createNotification } from '../db/models/notification.js';
import { listExecutions } from '../db/models/execution.js';
import { logger } from '../lib/logger.js';
import type { CoverageCheckConfig } from '../types.js';

const DEFAULT_CONFIG: CoverageCheckConfig = {
  enabled: true,
  threshold: 80,
  testCommand: 'npm test -- --coverage --json',
  filePatterns: ['*.ts', '*.js', '*.tsx', '*.jsx', '*.py'],
};

export class CoverageChecker {
  private config: CoverageCheckConfig;

  constructor(config?: Partial<CoverageCheckConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enabled) {
      eventBus.on('task:done', (event) => {
        const { taskId } = event.payload as { taskId: string };
        this.check(taskId).catch(err =>
          logger.warn({ taskId, error: err.message }, 'Coverage check failed')
        );
      });
      logger.info('Coverage checker active');
    }
  }

  shouldCheck(taskId: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    if (!task.workspacePath) return false;

    try {
      const diff = execSync('git diff --name-only HEAD~1', {
        cwd: task.workspacePath,
        encoding: 'utf-8',
        timeout: 10000,
      });
      const patterns = this.config.filePatterns;
      const hasCodeChanges = diff.split('\n').some(file =>
        patterns.some(pattern => {
          const ext = pattern.replace('*', '');
          return file.endsWith(ext);
        })
      );
      return hasCodeChanges;
    } catch {
      return false;
    }
  }

  async check(taskId: string): Promise<void> {
    if (!this.shouldCheck(taskId)) return;

    const task = getTask(taskId)!;
    const executions = listExecutions({ taskId });
    const execution = executions[executions.length - 1];
    if (!execution) return;

    let output: string;
    try {
      output = execSync(this.config.testCommand, {
        cwd: task.workspacePath!,
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      output = err.stdout || err.message;
      if (!output.includes('coverage')) {
        logger.warn({ taskId }, 'Coverage command produced no coverage data');
        return;
      }
    }

    const { lineCoverage, branchCoverage } = this.parseCoverageOutput(output);
    const passed = lineCoverage >= this.config.threshold;
    const summary = `Coverage: ${lineCoverage.toFixed(1)}% lines, ${branchCoverage.toFixed(1)}% branches (threshold: ${this.config.threshold}%)`;

    const report = createCoverageReport({
      taskId,
      executionId: execution.id,
      lineCoverage,
      branchCoverage,
      threshold: this.config.threshold,
      passed,
      summary,
    });

    eventBus.emit('coverage:report', { report });

    if (!passed) {
      createNotification({
        type: 'task_failed',
        title: 'Coverage Below Threshold',
        message: summary,
        taskId,
      });
    }

    logger.info({ taskId, lineCoverage, passed }, 'Coverage check completed');
  }

  parseCoverageOutput(output: string): { lineCoverage: number; branchCoverage: number } {
    try {
      const json = JSON.parse(output);
      if (json.total?.lines?.pct !== undefined) {
        return {
          lineCoverage: json.total.lines.pct,
          branchCoverage: json.total.branches?.pct ?? 0,
        };
      }
    } catch {}

    const match = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (match) {
      return {
        lineCoverage: parseFloat(match[1]),
        branchCoverage: parseFloat(match[2]),
      };
    }

    return { lineCoverage: 0, branchCoverage: 0 };
  }
}
