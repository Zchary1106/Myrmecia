# Agent Factory — 优化方案 v2

## 1. Agent Runtime：CLI → SDK

### 现状问题
```typescript
// ❌ 当前方案：裸调 CLI
spawn('claude', ['--print', task.input])
// 无法流式获取中间状态，只能等进程结束
// 错误处理粗糙（只有 exit code）
// 无法 mid-task 注入指令
```

### 优化方案
```typescript
// ✅ 使用 @anthropic-ai/claude-code SDK
import { query, type MessageEvent } from '@anthropic-ai/claude-code';

class AgentRuntime {
  async execute(agent: Agent, task: Task): Promise<TaskResult> {
    const abortController = new AbortController();
    
    const events = query({
      prompt: task.input,
      options: {
        model: agent.config.model || 'claude-sonnet-4-20250514',
        maxTurns: agent.config.maxTurns || 50,
        cwd: task.workdir || agent.config.workdir,
        systemPrompt: this.buildSystemPrompt(agent),
        abortController,
        allowedTools: agent.config.allowedTools || ['Read', 'Write', 'Edit', 'Bash'],
      }
    });

    for await (const event of events) {
      switch (event.type) {
        case 'assistant':
          // 实时推送 Agent 思考过程到 Dashboard
          this.eventBus.emit('agent:thinking', { agentId: agent.id, content: event.message });
          break;
        case 'tool_use':
          // 拦截危险操作，可触发 Human-in-the-Loop
          if (this.isDangerous(event)) {
            await this.requestHumanApproval(agent, task, event);
          }
          this.eventBus.emit('agent:tool', { agentId: agent.id, tool: event.name, input: event.input });
          break;
        case 'result':
          return { output: event.output, cost: event.usage };
      }
    }
  }

  // Mid-task 注入指令（用户从 Dashboard 发送纠正）
  async injectInstruction(agentId: string, instruction: string): Promise<void> {
    // 通过 AbortController 中断当前 turn，注入新指令后继续
  }
}
```

### 收益
- ✅ 流式日志，Dashboard 实时看到 Agent 思考过程
- ✅ Tool 调用拦截，危险操作可审批
- ✅ AbortController 优雅取消
- ✅ 精确 token 计量（每个 event 带 usage）
- ✅ Mid-task 指令注入

---

## 2. Workspace 隔离策略

### 现状问题
多 Agent 并行写同一目录 → 文件冲突、数据竞争。

### 优化方案
```
project/                          # 主仓库
├── .agent-factory/
│   ├── workspaces/
│   │   ├── pipeline-{id}/        # 每个 Pipeline 独立 workspace
│   │   │   ├── .git/            # git worktree
│   │   │   ├── stage-0-spec/
│   │   │   ├── stage-1-design/
│   │   │   └── stage-2-code/
│   │   └── task-{id}/           # 独立任务的 workspace
│   ├── artifacts/                # 最终产物（merge 后）
│   └── shared/                   # 只读共享上下文
```

**隔离规则：**
1. Pipeline 创建时 → `git worktree add` 创建独立工作树
2. 每个 Stage 在 worktree 内的子目录工作
3. Stage 之间通过 artifact 目录交接（output → 下一个 stage 的 input）
4. Pipeline 完成 → `git merge` 回主分支，用户确认后删除 worktree
5. 直接任务（Mode B）→ 可选择在主目录或独立 workspace

---

## 3. Master Agent 分解质量增强

### 现状问题
Master 一次性分解，复杂需求容易漏或分错，没有纠正机制。

### 优化方案：三层保障

```
用户需求 → Master 分解 → Review Agent 审核 → 执行
                ↑                                  │
                └──── 反馈回路 ←──── QA/Dev 反馈 ──┘
```

**层 1：分解审核**
```typescript
class MasterAgent {
  async decompose(task: Task): Promise<SubTask[]> {
    // Step 1: Master 分解
    const subtasks = await this.generateDecomposition(task);
    
    // Step 2: Review Agent 审核分解质量
    const review = await this.reviewDecomposition(subtasks, task);
    
    if (review.issues.length > 0) {
      // Step 3: Master 根据 review 修正
      return this.refineDecomposition(subtasks, review);
    }
    return subtasks;
  }
}
```

**层 2：动态补充**
- Dev 执行中发现 Spec 不够 → 触发 `needs_clarification` 事件
- Master 自动创建 "Spec 补充" 子任务给 PM
- PM 补充后，Dev 继续（带新上下文）

**层 3：反馈回路**
- QA 发现 bug → 自动创建 bugfix 子 Pipeline
- Review 提出架构问题 → 触发 Master 重新评估
- 失败任务 → Master 分析原因，决定重试/换 Agent/拆分

---

## 4. Context Window 管理

### 现状问题
Pipeline 后期，累积 input（spec + design + code + test）超 context window。

### 优化方案

```typescript
class ContextManager {
  // 每个 stage 输出两部分
  interface StageOutput {
    summary: string;      // < 2000 tokens，结构化摘要
    artifacts: string[];  // 完整文件路径
    keyDecisions: string; // 重要决策记录
  }
  
  // 下游 stage 的 input 构建
  async buildStageInput(pipeline: Pipeline, stageIndex: number): Promise<string> {
    const parts: string[] = [];
    
    // 1. 项目级 CLAUDE.md（固定上下文）
    parts.push(await this.getProjectContext(pipeline));
    
    // 2. 前序 stage 的 summary（非全文）
    for (let i = 0; i < stageIndex; i++) {
      parts.push(`## Stage ${i}: ${pipeline.stages[i].name}\n${pipeline.stages[i].output.summary}`);
    }
    
    // 3. 直接前驱的完整 output（只展开上一个 stage）
    const prev = pipeline.stages[stageIndex - 1];
    parts.push(`## 详细输入\n${await this.readArtifacts(prev.output.artifacts)}`);
    
    // 4. 文件引用而非 inline
    // 大文件通过 "请读取 {path}" 指令让 Agent 自己读
    
    return parts.join('\n\n---\n\n');
  }
}
```

---

## 5. OpenClaw 集成（替代独立通知系统）

### 方案
Agent Factory 作为 OpenClaw 的扩展，而非独立系统：

```
Agent Factory Dashboard (Web UI)
        ↕ API
Agent Factory Server (Express)
        ↕ Events
OpenClaw Gateway
        ↕ Push
企微 / Telegram / Discord
```

**集成点：**
1. **通知**：任务完成/失败 → OpenClaw → 企微消息推送
2. **控制**：在企微里发 "查看任务状态" → OpenClaw → 查询 Agent Factory API
3. **触发**：在企微里发 "帮我写一个天气 App" → OpenClaw → 创建 Pipeline
4. **可选 MCP Server**：把 Agent Factory 的 API 暴露为 MCP tools

---

## 6. 成本预估（执行前）

```typescript
class CostEstimator {
  // 基于历史数据的预估模型
  private history: Map<string, TaskCostHistory[]>;
  
  async estimate(pipeline: Pipeline): Promise<CostEstimate> {
    const stages = pipeline.stages.map(stage => {
      const avgCost = this.getHistoricalAvg(stage.agentRole, pipeline.complexity);
      return {
        stage: stage.name,
        agent: stage.agentRole,
        estimatedTokens: avgCost.tokens,
        estimatedCost: avgCost.cost,
        estimatedDuration: avgCost.duration,
        confidence: avgCost.sampleSize > 10 ? 'high' : 'low',
      };
    });
    
    return {
      totalEstimatedCost: stages.reduce((sum, s) => sum + s.estimatedCost, 0),
      totalEstimatedDuration: stages.reduce((sum, s) => sum + s.estimatedDuration, 0),
      breakdown: stages,
      warning: this.checkBudget(stages),
    };
  }
}

// Dashboard 显示：
// ┌─────────────────────────────────────┐
// │ 💰 Pipeline 成本预估                │
// │                                     │
// │ Spec (PM)    ~$0.50   ~2min   高置信 │
// │ Design (UI)  ~$0.80   ~3min   高置信 │
// │ Code (Dev)   ~$2.50   ~8min   中置信 │
// │ Test (QA)    ~$0.60   ~3min   高置信 │
// │ Deploy (Ops) ~$0.30   ~2min   高置信 │
// │ ──────────────────────────────────  │
// │ 总计         ~$4.70   ~18min        │
// │                                     │
// │ [确认执行]  [调整模型以降低成本]      │
// └─────────────────────────────────────┘
```

---

## 7. Agent 动态注册系统

### 架构
Agent = `SKILL.md` + `ModelConfig` + `Metadata`，支持热插拔。

```typescript
interface AgentDefinition {
  id: string;
  name: string;
  role: string;                    // 不再限制为固定枚举
  emoji: string;
  description: string;
  skillPath: string;               // 指向 SKILL.md
  modelConfig: AgentModelConfig;
  capabilities: string[];          // 标签，用于 Master 自动匹配
  triggers: string[];              // 关键词触发（Master 分配用）
}

class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();
  
  // 从目录扫描注册
  async scanAndRegister(dir: string): Promise<void> {
    // 读取 agents/ 目录下所有子目录
    // 每个子目录包含 agent.yaml + SKILL.md
  }
  
  // 动态注册（运行时 API）
  async register(def: AgentDefinition): Promise<void>;
  async unregister(id: string): Promise<void>;
  
  // Master 用：根据任务描述匹配最佳 Agent
  async matchAgents(taskDescription: string): Promise<AgentDefinition[]> {
    // 基于 capabilities + triggers 匹配
    // 支持模糊匹配和 LLM 辅助选择
  }
}
```

### Agent 配置文件格式
```yaml
# agents/dev/agent.yaml
id: dev
name: Dev Agent
emoji: ⌨️
role: developer
description: 全栈开发，写代码的主力
model:
  provider: claude
  model: claude-sonnet-4-20250514
  maxTokens: 8192
capabilities:
  - typescript
  - react
  - express
  - database
  - api
triggers:
  - 写代码
  - 实现
  - 开发
  - fix
  - implement
  - code
```
