import './load-env.js';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getDb } from './db/database.js';
import { AgentManager } from './agents/agent-manager.js';
import { TaskQueue } from './queue/task-queue.js';
import { PipelineEngine } from './pipelines/pipeline-engine.js';

import { NotifierService } from './notifications/notifier.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createAgentRoutes } from './routes/agents.js';
import { createPipelineRoutes } from './routes/pipelines.js';
import { createTemplateRoutes } from './routes/templates.js';
import { createSystemRoutes } from './routes/system.js';
import { createSupervisorRoutes } from './routes/supervisor.js';
import { createToolRoutes } from './routes/tools.js';
import { createModelRoutes } from './routes/models.js';
import { createSkillRoutes } from './routes/skills.js';
import { createSkillRegistryRoutes } from './routes/skill-registry.js';
import executionRoutes from './routes/executions.js';
import { SelfHealingEngine } from './agents/self-healing.js';
import { QualityLoop } from './pipelines/quality-loop.js';
import { CoverageChecker } from './workers/coverage-check.js';
import { ExecutionScorer } from './evaluation/execution-scorer.js';
import { PipelineRollback } from './pipelines/pipeline-rollback.js';
import { closeDb } from './db/database.js';
import { EventRecorder } from './events/event-recorder.js';
import { createApiAuthMiddleware, isApiAuthEnabled } from './auth/token-auth.js';
import { syncBuiltinTools } from './tools/tool-registry.js';
import { syncBuiltinModels } from './models/model-registry.js';
import { syncBuiltinSkills } from './skills/skill-registry.js';
import { seedDefaultSources, startAutoSync } from './skills/skill-registry-service.js';
import { SkillWatcher } from './skills/skill-watcher.js';
import { setSkillWatcher } from './skills/skill-watcher-instance.js';
import { logger } from './lib/logger.js';
import { securityMiddleware } from './middleware/security.js';
import { globalLimiter, writeLimiter } from './middleware/rate-limit.js';
import { globalErrorHandler } from './middleware/error-handler.js';
import { inputSanitizerMiddleware } from './middleware/input-sanitizer.js';
import { initTelemetry, telemetryMiddleware, metricsHandler } from './observability/telemetry.js';
import { tenantMiddleware } from './auth/tenant.js';
import { createAuthRoutes, sessionAuthMiddleware } from './auth/oidc.js';
import { createKnowledgeRoutes } from './knowledge/rag.js';
import { createMemoryRoutes } from './routes/memory.js';
import { GraphWorkflowEngine } from './agents/graph-workflow.js';
import { createGraphWorkflowRoutes } from './routes/graph-workflows.js';
import { getMcpManager } from './tools/mcp-manager.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createAuditRoutes } from './security/dlp.js';
import { createUsageRoutes } from './billing/usage.js';
import { createPluginRoutes } from './plugins/registry.js';
import { createBillingRoutes } from './billing/metering.js';
import { createEvalRoutes } from './evaluation/eval-framework.js';
import { openApiHandler } from './openapi/spec-generator.js';
import { createReleaseRoutes } from './deploy/release-manager.js';
import { createApiKeyRoutes } from './auth/api-keys.js';
import { createDLPRoutes } from './security/dlp-rules.js';
import { createChannelRoutes } from './notifications/channels.js';
import { createHealthRoutes } from './observability/health.js';
import { createCostDashboardRoutes } from './routes/cost-dashboard.js';
import { createExecutionAuditRoutes } from './routes/execution-audit.js';
import { pubsub, INSTANCE_ID } from './scaling/redis-pubsub.js';
import { createDistributedWSHub } from './scaling/distributed-ws.js';
import { workerPool } from './scaling/worker-pool.js';
import { initMemorySystem, getMemoryMaintenance } from './memory/index.js';
import { CapabilityRegistry } from './agents/capability-registry.js';
import { AgentComms } from './agents/agent-comms.js';
import { SharedArtifactStore } from './agents/shared-artifact-store.js';
import { createCapabilityRoutes } from './routes/capabilities.js';
import { createAgentCommsRoutes } from './routes/agent-comms.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { artifactCleanupWorker } from './workers/artifact-cleanup.js';
import { agentRuntime } from './agents/agent-runtime.js';
import { eventBus } from './events/event-bus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  // Initialize telemetry early (before other imports trigger HTTP calls)
  await initTelemetry();
  logger.info({ instanceId: INSTANCE_ID, workerMode: workerPool.mode }, 'Agent Factory starting...');

  // Initialize database
  logger.info('Initializing database...');
  getDb();
  new EventRecorder().start();
  logger.info('Syncing tool runtime...');
  syncBuiltinTools();
  logger.info('Syncing model registry...');
  syncBuiltinModels();

  // Initialize memory / trajectory learning system
  logger.info('Initializing memory system...');
  await initMemorySystem();

  // Periodic memory decay / forgetting (0 disables; default every 6h).
  const decayIntervalMs = Number(process.env.MEMORY_DECAY_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  if (decayIntervalMs > 0) {
    const decayTimer = setInterval(() => {
      getMemoryMaintenance().runDecay().catch(() => { /* non-critical */ });
    }, decayIntervalMs);
    decayTimer.unref?.();
  }

  // Initialize agent manager
  // Try multiple paths for registry.yaml (handles different CWDs)
  const possiblePaths = [
    join(__dirname, '../../../agents/registry.yaml'),
    join(process.cwd(), 'agents/registry.yaml'),
    join(process.cwd(), '../agents/registry.yaml'),
  ];
  const { existsSync } = await import('fs');
  const registryPath = possiblePaths.find(p => existsSync(p)) || possiblePaths[0];
  const agentManager = new AgentManager(registryPath);
  logger.info({ registryPath }, 'Loading agents from registry...');
  await agentManager.initializeFromRegistry();
  logger.info('Syncing skill registry...');
  syncBuiltinSkills(join(__dirname, '../../../agents'));
  seedDefaultSources();
  startAutoSync();
  const skillWatcher = new SkillWatcher(join(__dirname, '../../../agents'));
  setSkillWatcher(skillWatcher);
  skillWatcher.start();
  logger.info('Skill watcher active (hot-reload)');

  // Initialize capability registry
  const capabilityRegistry = new CapabilityRegistry();
  capabilityRegistry.buildIndex();
  logger.info('Capability registry built');

  // Initialize task queue (uses Redis if REDIS_URL is set, otherwise in-memory)
  logger.info('Initializing task queue...');
  const taskQueue = new TaskQueue(agentManager);

  // Initialize pipeline engine
  const pipelineEngine = new PipelineEngine(taskQueue, agentManager);
  const templatesDir = join(__dirname, '../../../templates');
  logger.info('Loading pipeline templates...');
  await pipelineEngine.loadTemplates(templatesDir);

  // Visual graph workflow engine (drag-and-drop manual orchestration)
  const graphWorkflowEngine = new GraphWorkflowEngine(taskQueue, agentManager);

  // Connect configured MCP servers (best-effort; from MCP_SERVERS env)
  await getMcpManager().init().catch(() => undefined);

  // Initialize notification service
  new NotifierService();

  // Initialize agent federation
  const agentComms = new AgentComms(capabilityRegistry, agentRuntime, taskQueue);
  const artifactStore = new SharedArtifactStore(capabilityRegistry);
  logger.info('Agent federation protocol active');

  // Initialize self-healing engine
  logger.info('Self-healing engine active');
  new SelfHealingEngine();

  // Initialize quality loop
  logger.info('Quality loop active');
  const qualityLoop = new QualityLoop();

  // Initialize coverage checker
  logger.info('Coverage checker active');
  new CoverageChecker();

  // Initialize execution scorer
  logger.info('Execution scorer active');
  new ExecutionScorer();

  // Initialize pipeline rollback handler
  logger.info('Pipeline rollback handler active');
  new PipelineRollback();

  // Express app
  const app = express();

  // CORS — restrict origins in production
  const corsOrigins = process.env.CORS_ORIGINS;
  app.use(cors(corsOrigins ? {
    origin: corsOrigins.split(',').map(o => o.trim()),
    credentials: true,
  } : undefined));

  // HSTS — enforce HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      next();
    });
  }

  // Health routes (before auth so K8s probes work unauthenticated)
  app.use('/health', createHealthRoutes());

  securityMiddleware.forEach(mw => app.use(mw));
  app.use(globalLimiter);
  app.use(telemetryMiddleware);
  app.use('/api', writeLimiter);
  app.use('/api', inputSanitizerMiddleware);
  app.use('/api', createApiAuthMiddleware({ publicPaths: ['/health'] }));
  // Also apply auth to /api/v1
  app.use('/api/v1', writeLimiter);
  app.use('/api/v1', createApiAuthMiddleware({ publicPaths: ['/health'] }));
  app.use('/api/v1', tenantMiddleware());

  // Metrics endpoint (no auth required)
  app.get('/metrics', metricsHandler);

  // Auth routes (no auth required)
  app.use('/auth', createAuthRoutes());

  // API v1 Routes (canonical)
  app.use('/api/v1/tasks', createTaskRoutes(taskQueue));
  app.use('/api/v1/agents', createAgentRoutes(taskQueue));
  app.use('/api/v1/tools', createToolRoutes());
  app.use('/api/v1/models', createModelRoutes());
  app.use('/api/v1/skills', createSkillRoutes());
  app.use('/api/v1/skills/registry', createSkillRegistryRoutes());
  app.use('/api/v1/executions', executionRoutes);
  app.use('/api/v1/pipelines', createPipelineRoutes(pipelineEngine));
  app.use('/api/v1/templates', createTemplateRoutes());
  app.use('/api/v1', createSystemRoutes());
  app.use('/api/v1/knowledge', createKnowledgeRoutes());
  app.use('/api/v1/memory', createMemoryRoutes());
  app.use('/api/v1/graph-workflows', createGraphWorkflowRoutes(graphWorkflowEngine));
  app.use('/api/v1/mcp', createMcpRoutes());
  app.use('/api/v1/audit', createAuditRoutes());
  app.use('/api/v1/usage', createUsageRoutes());
  app.use('/api/v1/plugins', createPluginRoutes());
  app.use('/api/v1/billing', createBillingRoutes());
  app.use('/api/v1/eval', createEvalRoutes());
  app.use('/api/v1/releases', createReleaseRoutes());
  app.use('/api/v1/api-keys', createApiKeyRoutes());
  app.use('/api/v1/dlp-rules', createDLPRoutes());
  app.use('/api/v1/notification-channels', createChannelRoutes());
  app.use('/api/v1/cost-dashboard', createCostDashboardRoutes());
  app.use('/api/v1/execution-audit', createExecutionAuditRoutes());
  app.use('/api/v1/capabilities', createCapabilityRoutes(capabilityRegistry));
  app.use('/api/v1/agent-comms', createAgentCommsRoutes(agentComms));
  app.use('/api/v1/artifacts', createArtifactRoutes(artifactStore));
  app.get('/api/v1/openapi.json', openApiHandler);
  const supervisorRoutes = createSupervisorRoutes(taskQueue, pipelineEngine, agentManager);
  app.use('/api/v1/supervisor', supervisorRoutes);

  // Legacy /api routes (deprecated alias → same handlers, adds deprecation header)
  const deprecationNotice: import('express').RequestHandler = (_req, res, next) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-12-31');
    res.setHeader('Link', '</api/v1>; rel="successor-version"');
    next();
  };
  app.use('/api/tasks', deprecationNotice, createTaskRoutes(taskQueue));
  app.use('/api/agents', deprecationNotice, createAgentRoutes(taskQueue));
  app.use('/api/tools', deprecationNotice, createToolRoutes());
  app.use('/api/models', deprecationNotice, createModelRoutes());
  app.use('/api/skills', deprecationNotice, createSkillRoutes());
  app.use('/api/executions', deprecationNotice, executionRoutes);
  app.use('/api/pipelines', deprecationNotice, createPipelineRoutes(pipelineEngine));
  app.use('/api/templates', deprecationNotice, createTemplateRoutes());
  app.use('/api/execution-audit', deprecationNotice, createExecutionAuditRoutes());
  app.use('/api', deprecationNotice, createSystemRoutes());
  app.use('/api/supervisor', deprecationNotice, supervisorRoutes);

  // Global error handler (must be after all routes)
  app.use(globalErrorHandler);

  // HTTP + WebSocket server (distributed via Redis pub/sub)
  const server = createServer(app);
  const wsHub = await createDistributedWSHub(server);

  // Initialize worker pool
  await workerPool.initialize();

  // Artifact cleanup worker
  setInterval(() => artifactCleanupWorker.run({ logger, emit: (t, p) => eventBus.emit(t as any, p) }), artifactCleanupWorker.intervalMs);

  server.listen(PORT, async () => {
    logger.info(`Agent Factory running on http://localhost:${PORT}`);
    logger.info(`WebSocket: ws://localhost:${PORT}/ws`);
    logger.info(`API auth: ${isApiAuthEnabled() ? 'enabled' : 'disabled (local mode)'}`);

    // Recover any tasks interrupted by previous shutdown
    await taskQueue.recoverRunningTasks();
    await pipelineEngine.recoverInterruptedPipelines();
    await qualityLoop.recoverInterruptedAttempts();
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    const { shutdownTelemetry } = await import('./observability/telemetry.js');
    await shutdownTelemetry();
    await workerPool.shutdown();
    await pubsub.shutdown();
    await taskQueue.shutdown();
    skillWatcher.stop();
    closeDb();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err: unknown) => {
    logger.error({ err }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err: unknown) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    closeDb();
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start Agent Factory');
  process.exit(1);
});
