import { Router } from 'express';
import type { AgentComms } from '../agents/agent-comms.js';
import { listCommLogs } from '../db/models/agent-comm-log.js';

export function createAgentCommsRoutes(agentComms: AgentComms): Router {
  const router = Router();

  router.post('/request', async (req, res) => {
    try {
      const { from, capability, payload, timeout } = req.body;
      if (!from || !capability) {
        return res.status(400).json({ error: 'from and capability are required' });
      }
      const result = await agentComms.request({ from, capability, payload, timeout });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/send', async (req, res) => {
    try {
      const { from, capability, payload, replyTo } = req.body;
      if (!from || !capability) {
        return res.status(400).json({ error: 'from and capability are required' });
      }
      const messageId = await agentComms.send({ from, capability, payload, replyTo });
      res.status(201).json({ messageId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/log', (req, res) => {
    const logs = listCommLogs({
      capability: req.query.capability as string,
      fromAgentId: req.query.from as string,
      toAgentId: req.query.to as string,
      limit: parseInt(req.query.limit as string) || 50,
    });
    res.json(logs);
  });

  router.get('/:id', (req, res) => {
    const status = agentComms.getMessageStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Message not found' });
    res.json(status);
  });

  return router;
}
