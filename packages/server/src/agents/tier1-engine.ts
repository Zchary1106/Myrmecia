/**
 * Tier 1 Engine — Rule-based fast processing for simple tasks
 *
 * Handles trivial, pattern-matching tasks without calling LLM:
 * - Variable renaming
 * - Format/lint
 * - Git operations
 * - Simple imports
 *
 * Zero token cost, <100ms latency.
 */

import { logger } from '../lib/logger.js';

// ---------- Types ----------

export interface Tier1Result {
  handled: boolean;
  intentType?: string;
  output?: string;
  commands?: string[];
  durationMs: number;
}

interface Tier1Rule {
  id: string;
  patterns: RegExp[];
  extract: (input: string, match: RegExpMatchArray) => Tier1Result;
}

// ---------- Rules ----------

const rules: Tier1Rule[] = [
  // Rename variable/function
  {
    id: 'rename_var',
    patterns: [
      /(?:把|将|rename)\s*[`"']?(\w+)[`"']?\s*(?:改为|改成|重命名为|改名为|to|→)\s*[`"']?(\w+)[`"']?/i,
      /rename\s+(\w+)\s+(?:to|as|→)\s+(\w+)/i,
    ],
    extract: (input, match) => ({
      handled: true,
      intentType: 'rename_var',
      output: `Rename \`${match[1]}\` → \`${match[2]}\``,
      commands: [
        `find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" | xargs sed -i '' 's/\\b${match[1]}\\b/${match[2]}/g'`,
      ],
      durationMs: 0,
    }),
  },

  // Format code
  {
    id: 'format',
    patterns: [
      /^(?:格式化|format|prettier|美化)(?:\s+(?:代码|code|files?))?$/i,
      /^(?:run|执行)\s*(?:prettier|eslint\s*--fix|format)/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'format',
      output: 'Format code with Prettier',
      commands: ['npx prettier --write "src/**/*.{ts,tsx,js,jsx}"'],
      durationMs: 0,
    }),
  },

  // Lint fix
  {
    id: 'lint_fix',
    patterns: [
      /^(?:fix|修复)\s*(?:lint|eslint|代码规范)(?:\s*(?:错误|errors?))?$/i,
      /^eslint\s*--fix$/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'lint_fix',
      output: 'Fix lint errors',
      commands: ['npx eslint --fix "src/**/*.{ts,tsx}"'],
      durationMs: 0,
    }),
  },

  // Git commit
  {
    id: 'git_commit',
    patterns: [
      /^(?:提交|commit)(?:\s*(?:代码|changes?|all))?(?:\s*[：:]\s*(.+))?$/i,
      /^git\s+commit\s*(?:-m\s*)?["']?(.+?)["']?$/i,
    ],
    extract: (input, match) => {
      const msg = match[1] || 'update';
      return {
        handled: true,
        intentType: 'git_commit',
        output: `Git commit: "${msg}"`,
        commands: ['git add -A', `git commit -m "${msg}"`],
        durationMs: 0,
      };
    },
  },

  // Git push
  {
    id: 'git_push',
    patterns: [
      /^(?:推送|push|上传|git\s+push)$/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'git_push',
      output: 'Push to remote',
      commands: ['git push'],
      durationMs: 0,
    }),
  },

  // Git status
  {
    id: 'git_status',
    patterns: [
      /^(?:状态|status|git\s+status|查看状态)$/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'git_status',
      output: 'Check git status',
      commands: ['git status'],
      durationMs: 0,
    }),
  },

  // Add import
  {
    id: 'add_import',
    patterns: [
      /^(?:导入|import|引入)\s+[`"']?(\w+)[`"']?\s*(?:from|从)\s*[`"']?([^`"'\s]+)[`"']?/i,
    ],
    extract: (_input, match) => ({
      handled: true,
      intentType: 'add_import',
      output: `Add import: \`import { ${match[1]} } from '${match[2]}'\``,
      commands: [],
      durationMs: 0,
    }),
  },

  // Install package
  {
    id: 'install_pkg',
    patterns: [
      /^(?:安装|install|add)\s+(?:package\s+|依赖\s+)?(\S+)$/i,
      /^(?:pnpm|npm|yarn)\s+(?:add|install|i)\s+(\S+)/i,
    ],
    extract: (_input, match) => ({
      handled: true,
      intentType: 'install_pkg',
      output: `Install package: ${match[1]}`,
      commands: [`pnpm add ${match[1]}`],
      durationMs: 0,
    }),
  },

  // Run tests
  {
    id: 'run_tests',
    patterns: [
      /^(?:跑|运行|run)\s*(?:测试|tests?|test suite)$/i,
      /^(?:pnpm|npm)\s+test$/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'run_tests',
      output: 'Run test suite',
      commands: ['pnpm test'],
      durationMs: 0,
    }),
  },

  // Type check
  {
    id: 'type_check',
    patterns: [
      /^(?:类型检查|type\s*check|tsc|检查类型)$/i,
    ],
    extract: () => ({
      handled: true,
      intentType: 'type_check',
      output: 'Run TypeScript type check',
      commands: ['npx tsc --noEmit'],
      durationMs: 0,
    }),
  },
];

// ---------- Engine ----------

export class Tier1Engine {
  /**
   * Attempt to handle input with rule engine.
   * Returns handled=false if no rule matches (needs LLM).
   */
  process(input: string): Tier1Result {
    const start = Date.now();
    const trimmed = input.trim();

    for (const rule of rules) {
      for (const pattern of rule.patterns) {
        const match = trimmed.match(pattern);
        if (match) {
          const result = rule.extract(trimmed, match);
          result.durationMs = Date.now() - start;
          logger.info({ ruleId: rule.id, durationMs: result.durationMs }, 'Tier 1 handled');
          return result;
        }
      }
    }

    return { handled: false, durationMs: Date.now() - start };
  }
}

export const tier1Engine = new Tier1Engine();
