import pino, { type Logger } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export type { Logger };

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});
