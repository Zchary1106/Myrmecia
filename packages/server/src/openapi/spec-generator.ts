/**
 * OpenAPI Spec Generator (Task #16)
 *
 * Generates an OpenAPI 3.0 specification for the Agent Factory API.
 */

import { Router, RequestHandler } from 'express';

// ---------- Spec Generation ----------

export function generateOpenAPISpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Agent Factory API',
      version: '1.0.0',
      description: 'Multi-agent orchestration platform API',
    },
    servers: [
      { url: '/api/v1', description: 'Primary API' },
    ],
    paths: {
      '/tasks': {
        get: { summary: 'List tasks', tags: ['Tasks'], responses: { '200': { description: 'Task list' } } },
        post: { summary: 'Create task', tags: ['Tasks'], responses: { '201': { description: 'Task created' } } },
      },
      '/tasks/{id}': {
        get: { summary: 'Get task', tags: ['Tasks'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Task details' } } },
      },
      '/agents': {
        get: { summary: 'List agents', tags: ['Agents'], responses: { '200': { description: 'Agent list' } } },
      },
      '/agents/{id}': {
        get: { summary: 'Get agent', tags: ['Agents'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Agent details' } } },
      },
      '/executions': {
        get: { summary: 'List executions', tags: ['Executions'], responses: { '200': { description: 'Execution list' } } },
      },
      '/pipelines': {
        get: { summary: 'List pipelines', tags: ['Pipelines'], responses: { '200': { description: 'Pipeline list' } } },
        post: { summary: 'Create pipeline', tags: ['Pipelines'], responses: { '201': { description: 'Pipeline created' } } },
      },
      '/knowledge/search': {
        post: { summary: 'Search knowledge base', tags: ['Knowledge'], responses: { '200': { description: 'Search results' } } },
      },
      '/plugins': {
        get: { summary: 'List plugins', tags: ['Plugins'], responses: { '200': { description: 'Plugin list' } } },
        post: { summary: 'Install plugin', tags: ['Plugins'], responses: { '201': { description: 'Plugin installed' } } },
      },
      '/releases': {
        get: { summary: 'List releases', tags: ['Releases'], responses: { '200': { description: 'Release list' } } },
        post: { summary: 'Create release', tags: ['Releases'], responses: { '201': { description: 'Release created' } } },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    security: [{ bearerAuth: [] }, { apiKey: [] }],
  };
}

// ---------- Route Handler ----------

export const openApiHandler: RequestHandler = (_req, res) => {
  res.json(generateOpenAPISpec());
};
