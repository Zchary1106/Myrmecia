import { getDb } from '../database.js';
import { v4 as uuid } from 'uuid';
import type { CoverageReport } from '../../types.js';

function rowToReport(row: any): CoverageReport {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    lineCoverage: row.line_coverage,
    branchCoverage: row.branch_coverage,
    threshold: row.threshold,
    passed: !!row.passed,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export function createCoverageReport(data: {
  taskId: string;
  executionId: string;
  lineCoverage: number;
  branchCoverage: number;
  threshold: number;
  passed: boolean;
  summary: string;
}): CoverageReport {
  const db = getDb();
  const id = `cov_${uuid().slice(0, 8)}`;
  db.run(`
    INSERT INTO coverage_reports (id, task_id, execution_id, line_coverage, branch_coverage, threshold, passed, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, id, data.taskId, data.executionId, data.lineCoverage, data.branchCoverage, data.threshold, data.passed ? 1 : 0, data.summary);
  return getCoverageReport(id)!;
}

export function getCoverageReport(id: string): CoverageReport | undefined {
  const db = getDb();
  const row = db.get('SELECT * FROM coverage_reports WHERE id = ?', id);
  return row ? rowToReport(row) : undefined;
}

export function listCoverageReports(filter?: { taskId?: string; passed?: boolean }): CoverageReport[] {
  const db = getDb();
  let sql = 'SELECT * FROM coverage_reports';
  const conditions: string[] = [];
  const params: any[] = [];
  if (filter?.taskId) { conditions.push('task_id = ?'); params.push(filter.taskId); }
  if (filter?.passed !== undefined) { conditions.push('passed = ?'); params.push(filter.passed ? 1 : 0); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  return db.all(sql, ...params).map(rowToReport);
}
