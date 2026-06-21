import { listAgents } from '../db/models/agent.js';
import { listTemplates } from '../db/models/pipeline.js';
import { agentRuntime } from '../agents/agent-runtime.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import type { Task } from '../types.js';

export interface TaskIntent {
  type: 'new_product' | 'feature' | 'bugfix' | 'direct' | 'content';
  complexity: 'trivial' | 'medium' | 'high' | 'epic';
  suggestedMode: 'direct' | 'pipeline' | 'master';
  suggestedAgent?: string;      // agent id for direct mode
  suggestedTemplate?: string;   // template id for pipeline mode
  confidence?: number;          // 0-1, from semantic routing
  routingSource?: 'regex' | 'semantic' | 'llm';  // how the decision was made
}

/**
 * Intent Classifier for Supervisor Mode
 * Analyzes user input and determines the best execution strategy.
 * Uses explicit keyword regex first, semantic routing for ambiguous inputs when
 * historical data is available, then LLM as the final fallback.
 */
export class IntentClassifier {
  /** Classify user input into execution intent */
  async classify(input: string): Promise<TaskIntent> {
    // 1. Fast-path: explicit keyword intent should not be overwritten by history.
    const fast = this.fastClassify(input);
    if (fast) {
      return { ...fast, routingSource: 'regex' };
    }

    // 2. Semantic routing: learn from historical trajectories
    try {
      const store = getTrajectoryStore();
      const recommendation = await store.recommendRoute(input);
      if (recommendation && recommendation.confidence > 0.75) {
        return {
          type: this.inferTypeFromMode(recommendation.suggestedMode),
          complexity: this.inferComplexity(input),
          suggestedMode: recommendation.suggestedMode as any,
          suggestedAgent: recommendation.suggestedAgent,
          suggestedTemplate: recommendation.suggestedTemplate,
          confidence: recommendation.confidence,
          routingSource: 'semantic',
        };
      }
    } catch {
      // Semantic routing not available yet, continue to fallback
    }

    // 3. LLM fallback
    const llmResult = await this.llmClassify(input);
    return { ...llmResult, routingSource: 'llm' };
  }

  /** Infer task type from mode */
  private inferTypeFromMode(mode: string): TaskIntent['type'] {
    switch (mode) {
      case 'master': return 'new_product';
      case 'pipeline': return 'feature';
      default: return 'direct';
    }
  }

  /** Infer complexity from input length and patterns */
  private inferComplexity(input: string): TaskIntent['complexity'] {
    const wordCount = input.split(/\s+/).length;
    if (wordCount > 80) return 'epic';
    if (wordCount > 40) return 'high';
    if (wordCount > 15) return 'medium';
    return 'trivial';
  }

  /** Keyword-based fast classification */
  private fastClassify(input: string): TaskIntent | null {
    const lower = input.toLowerCase();

    // Bug patterns
    if (/bug|fix|修复|修|报错|error|crash|broken|坏了|不工作/.test(lower)) {
      return {
        type: 'bugfix',
        complexity: 'medium',
        suggestedMode: 'pipeline',
        suggestedTemplate: this.findTemplate('bugfix'),
      };
    }

    // Review patterns
    if (/review|审查|代码审核|check|security scan/.test(lower)) {
      return { type: 'direct', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'review' };
    }

    // Deploy patterns
    if (/部署|deploy|上线|发布|release/.test(lower)) {
      return { type: 'direct', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'ops' };
    }

    // Test patterns
    if (/测试|test|QA|验证/.test(lower)) {
      return { type: 'direct', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'qa' };
    }

    // Content patterns
    if (/公众号|文章|推文|wechat|微信/.test(lower)) {
      return { type: 'content', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'wechat-writer' };
    }
    if (/小红书|笔记|种草|rednote/.test(lower)) {
      return { type: 'content', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'xiaohongshu-writer' };
    }

    // Translation
    if (/翻译|i18n|国际化|translate/.test(lower)) {
      return { type: 'direct', complexity: 'trivial', suggestedMode: 'direct', suggestedAgent: 'i18n' };
    }

    // Large project patterns
    if (/做一个|build a|create a|开发一个|全栈|SaaS|平台|系统/.test(lower)) {
      const complexity = lower.length > 100 ? 'epic' : 'high';
      return {
        type: 'new_product',
        complexity,
        suggestedMode: complexity === 'epic' ? 'master' : 'pipeline',
        suggestedTemplate: this.findTemplate('full-product') || this.findTemplate('full'),
      };
    }

    // Feature patterns
    if (/加个|添加|新增|加一个|feature|add|implement|实现/.test(lower)) {
      return {
        type: 'feature',
        complexity: 'medium',
        suggestedMode: 'pipeline',
        suggestedTemplate: this.findTemplate('feature'),
      };
    }

    return null; // Ambiguous, needs LLM
  }

  /** LLM-based classification for ambiguous inputs */
  private async llmClassify(input: string): Promise<TaskIntent> {
    // Default: use master mode for anything complex
    const wordCount = input.split(/\s+/).length;
    if (wordCount > 30) {
      return {
        type: 'new_product',
        complexity: 'high',
        suggestedMode: 'master',
      };
    }

    // Default: direct assignment to dev for simple tasks
    return {
      type: 'feature',
      complexity: 'medium',
      suggestedMode: 'direct',
      suggestedAgent: 'dev',
    };
  }

  private findTemplate(keyword: string): string | undefined {
    const templates = listTemplates();
    return templates.find(t => t.name.toLowerCase().includes(keyword))?.id;
  }
}

export const intentClassifier = new IntentClassifier();
