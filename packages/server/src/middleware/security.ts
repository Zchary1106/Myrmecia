import helmet from 'helmet';
import express from 'express';
import type { RequestHandler } from 'express';

/**
 * Security middleware stack:
 * - helmet: sets secure HTTP headers
 * - json body parser with size limit
 */
export const securityMiddleware: RequestHandler[] = [
  helmet() as unknown as RequestHandler,
  express.json({ limit: '1mb' }),
];
