/**
 * Safety Guardrails
 * Enforces cost limits, operation boundaries, and approval requirements.
 */
export interface GuardrailConfig {
  maxCostPerTask: number;       // USD
  maxCostPerDay: number;        // USD
  canDeploy: boolean;
  canDeleteFiles: boolean;
  canAccessNetwork: boolean;
  canModifyGitHistory: boolean;
  requireApproval: string[];
  autoApprove: string[];
}

const DEFAULT_CONFIG: GuardrailConfig = {
  maxCostPerTask: 5,
  maxCostPerDay: 20,
  canDeploy: false,
  canDeleteFiles: false,
  canAccessNetwork: true,
  canModifyGitHistory: false,
  requireApproval: [
    'deploy_to_production',
    'delete_database',
    'change_architecture',
    'exceed_budget_50pct',
    'third_party_api_key',
  ],
  autoApprove: [
    'install_npm_package',
    'create_branch',
    'run_tests',
    'deploy_to_staging',
    'retry_failed_task',
  ],
};

class SafetyGuardrails {
  private config: GuardrailConfig;
  private dailyCost = 0;
  private taskCosts = new Map<string, number>();

  constructor(config?: Partial<GuardrailConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Reset daily cost at midnight
    this.scheduleDailyReset();
  }

  /** Check if an operation is allowed */
  checkOperation(operation: string): { allowed: boolean; reason?: string } {
    if (this.config.requireApproval.includes(operation)) {
      return { allowed: false, reason: `Operation "${operation}" requires supervisor approval` };
    }
    if (this.config.autoApprove.includes(operation)) {
      return { allowed: true };
    }

    // Specific checks
    if (operation === 'deploy' && !this.config.canDeploy) {
      return { allowed: false, reason: 'Deployment is disabled. Enable in settings.' };
    }
    if (operation === 'delete_files' && !this.config.canDeleteFiles) {
      return { allowed: false, reason: 'File deletion is disabled.' };
    }
    if (operation === 'force_push' && !this.config.canModifyGitHistory) {
      return { allowed: false, reason: 'Git history modification is disabled.' };
    }

    return { allowed: true };
  }

  /** Check if cost budget allows a new task */
  checkBudget(estimatedCost?: number): { allowed: boolean; reason?: string; remaining: number } {
    const remaining = this.config.maxCostPerDay - this.dailyCost;

    if (estimatedCost && estimatedCost > this.config.maxCostPerTask) {
      return { allowed: false, reason: `Estimated cost $${estimatedCost} exceeds per-task limit of $${this.config.maxCostPerTask}`, remaining };
    }

    if (this.dailyCost >= this.config.maxCostPerDay) {
      return { allowed: false, reason: `Daily budget of $${this.config.maxCostPerDay} reached`, remaining: 0 };
    }

    if (this.dailyCost >= this.config.maxCostPerDay * 0.8) {
      // Warning at 80%
      return { allowed: true, reason: `Warning: ${Math.round((this.dailyCost / this.config.maxCostPerDay) * 100)}% of daily budget used`, remaining };
    }

    return { allowed: true, remaining };
  }

  /** Track cost for a task */
  trackCost(taskId: string, cost: number) {
    this.taskCosts.set(taskId, (this.taskCosts.get(taskId) || 0) + cost);
    this.dailyCost += cost;
  }

  /** Get current cost summary */
  getCostSummary() {
    return {
      dailyCost: this.dailyCost,
      dailyBudget: this.config.maxCostPerDay,
      dailyRemaining: this.config.maxCostPerDay - this.dailyCost,
      percentUsed: Math.round((this.dailyCost / this.config.maxCostPerDay) * 100),
      taskCosts: Object.fromEntries(this.taskCosts),
    };
  }

  /** Update guardrail config */
  updateConfig(updates: Partial<GuardrailConfig>) {
    this.config = { ...this.config, ...updates };
  }

  getConfig(): GuardrailConfig {
    return { ...this.config };
  }

  private scheduleDailyReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      this.dailyCost = 0;
      this.taskCosts.clear();
      this.scheduleDailyReset();
    }, msUntilMidnight);
  }
}

export const guardrails = new SafetyGuardrails();
