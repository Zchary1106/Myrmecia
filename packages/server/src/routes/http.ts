import type { Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import type { OperatorActor, OperatorRole } from '../types.js';

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'CONFIRMATION_REQUIRED'
  | 'OPERATOR_FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INTERNAL';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode | string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parseBody<T>(schema: ZodSchema<T>, req: Request): T {
  try {
    return schema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Request body validation failed', err.issues);
    }
    throw err;
  }
}

export function parseQuery<T>(schema: ZodSchema<T>, req: Request): T {
  try {
    return schema.parse(req.query);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Query validation failed', err.issues);
    }
    throw err;
  }
}

export function requireConfirmation(req: Request, operation: string) {
  const body = req.body || {};
  if (body.confirm === true || body.confirmation === operation) return;
  throw new HttpError(
    409,
    'CONFIRMATION_REQUIRED',
    `Operation "${operation}" requires explicit confirmation`,
    { operation, required: { confirm: true } },
  );
}

export function actorFromRequest(req: Request): OperatorActor {
  const proxyActor = req.header('x-operator-id')?.trim();
  if (proxyActor) {
    const roleHeader = req.header('x-operator-role') as OperatorRole | undefined;
    const role: OperatorRole = roleHeader && ['admin', 'operator', 'viewer'].includes(roleHeader)
      ? roleHeader
      : 'admin';
    return { id: proxyActor, role, source: 'proxy' };
  }

  const hasToken = !!req.header('authorization');
  return {
    id: hasToken ? 'token-admin' : 'local-admin',
    role: 'admin',
    source: hasToken ? 'token' : 'local',
  };
}

export function requireOperatorRole(
  req: Request,
  operation: string,
  allowedRoles: OperatorRole[],
): OperatorActor {
  const actor = actorFromRequest(req);
  if (allowedRoles.includes(actor.role)) return actor;
  throw new HttpError(
    403,
    'OPERATOR_FORBIDDEN',
    `Operator role "${actor.role}" is not allowed to perform "${operation}"`,
    { operation, actor, allowedRoles },
  );
}

export function notFound(code: string, message: string): never {
  throw new HttpError(404, code, message);
}

export function sendError(res: Response, err: unknown) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  return res.status(500).json({ error: { code: 'INTERNAL', message } });
}
