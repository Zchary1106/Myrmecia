import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getDb } from './db/database.js';
import { AgentManager } from './agents/agent-manager.js';
import { TaskQueue } from './queue/task-queue.js';
import { PipelineEngine } from './pipelines/pipeline-engine.js';
import { WSHub } from './ws/ws-hub.js';
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
import executionRoutes from './routes/executions.js';
import { SelfHealingEngine } from './agents/self-healing.js';
import { QualityLoop } from './pipelines/quality-loop.js';
import { closeDb } from './db/database.js';
import { EventRecorder } from './events/event-recorder.js';
import { createApiAuthMiddleware, isApiAuthEnabled } from './auth/token-auth.js';
import { syncBuiltinTools } from './tools/tool-registry.js';
import { syncBuiltinModels } from './models/model-registry.js';
import { syncBuiltinSkills } from './skills/skill-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  console.log('🏭 Agent Factory starting...\n');

  // Initialize database
  console.log('📦 Initializing database...');
  getDb();
  new EventRecorder().start();
  console.log('🧰 Syncing tool runtime...');
  syncBuiltinTools();
  console.log('🧠 Syncing model registry...');
  syncBuiltinModels();

  // Initialize agent manager
  const registryPath = join(__dirname, '../../../agents/registry.yaml');
  const agentManager = new AgentManager(registryPath);
  console.log('🤖 Loading agents from registry...');
  await agentManager.initializeFromRegistry();
  console.log('📚 Syncing skill registry...');
  syncBuiltinSkills(join(__dirname, '../../../agents'));

  // Initialize task queue (uses Redis if REDIS_URL is set, otherwise in-memory)
  console.log('📮 Initializing task queue...');
  const taskQueue = new TaskQueue(agentManager);

  // Initialize pipeline engine
  const pipelineEngine = new PipelineEngine(taskQueue, agentManager);
  const templatesDir = join(__dirname, '../../../templates');
  console.log('📋 Loading pipeline templates...');
  await pipelineEngine.loadTemplates(templatesDir);

  // Initialize notification service
  new NotifierService();

  // Initialize self-healing engine
  console.log('🛡️ Self-healing engine active');
  new SelfHealingEngine();

  // Initialize quality loop
  console.log('🔄 Quality loop active');
  const qualityLoop = new QualityLoop();

  // Express app
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', createApiAuthMiddleware({ publicPaths: ['/health'] }));

  // API Routes
  app.use('/api/tasks', createTaskRoutes(taskQueue));
  app.use('/api/agents', createAgentRoutes(taskQueue));
  app.use('/api/tools', createToolRoutes());
  app.use('/api/models', createModelRoutes());
  app.use('/api/skills', createSkillRoutes());
  app.use('/api/executions', executionRoutes);
  app.use('/api/pipelines', createPipelineRoutes(pipelineEngine));
  app.use('/api/templates', createTemplateRoutes());
  app.use('/api', createSystemRoutes());
  app.use('/api/supervisor', createSupervisorRoutes(taskQueue, pipelineEngine));

  // HTTP + WebSocket server
  const server = createServer(app);
  const wsHub = new WSHub(server);

  server.listen(PORT, async () => {
    console.log(`\n✅ Agent Factory running on http://localhost:${PORT}`);
    console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`   Dashboard: http://localhost:5173\n`);
    console.log(`   API auth: ${isApiAuthEnabled() ? 'enabled' : 'disabled (local mode)'}\n`);

    // Recover any tasks interrupted by previous shutdown
    await taskQueue.recoverRunningTasks();
    await pipelineEngine.recoverInterruptedPipelines();
    await qualityLoop.recoverInterruptedAttempts();
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await taskQueue.shutdown();
    closeDb();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err: any) => {
    console.error('[unhandledRejection]', err?.message || err);
  });
}

main().catch(console.error);
