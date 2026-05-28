import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

const isDev = process.env.NODE_ENV !== 'production';

/** Global rate limit: disabled in dev, 600/min in production */
export const globalLimiter: RequestHandler = isDev
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { message: 'Too many requests, please try again later.' } },
    });

/** Stricter limit for write operations: disabled in dev, 60/min in production */
export const writeLimiter: RequestHandler = isDev
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60_000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { message: 'Too many write requests, please try again later.' } },
    });
