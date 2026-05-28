/**
 * Global Error Handler & Request Validation Middleware
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { logger } from '../lib/logger.js';

/**
 * Global error handler — catches all unhandled errors in route handlers.
 * Must be registered AFTER all routes.
 */
export const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: 'Validation failed',
        details: err.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  // Known operational errors
  if (err.statusCode || err.status) {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({
      error: { message: err.message || 'Request failed' },
    });
    return;
  }

  // Unexpected errors
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error in request');
  res.status(500).json({
    error: { message: 'Internal server error' },
  });
};

/**
 * Request body validation middleware factory.
 * Usage: router.post('/tasks', validate(createTaskSchema), handler)
 */
export function validate(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(err); // Caught by globalErrorHandler
    }
  };
}

/**
 * Async route wrapper — catches async errors and forwards to error handler.
 * Usage: router.get('/tasks', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn: (req: any, res: any, next: any) => Promise<any>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
