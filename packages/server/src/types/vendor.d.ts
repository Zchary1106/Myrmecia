declare module 'pino' {
  export interface Logger {
    info(msg: string): void;
    info(obj: object, msg?: string): void;
    warn(msg: string): void;
    warn(obj: object, msg?: string): void;
    error(msg: string): void;
    error(obj: object, msg?: string): void;
    debug(msg: string): void;
    debug(obj: object, msg?: string): void;
    fatal(msg: string): void;
    fatal(obj: object, msg?: string): void;
    child(bindings: object): Logger;
  }
  export interface Options {
    level?: string;
    transport?: { target: string; options?: object };
  }
  export default function pino(opts?: Options): Logger;
}

declare module 'helmet' {
  import type { RequestHandler } from 'express';
  function helmet(opts?: object): RequestHandler;
  export = helmet;
}

declare module 'express-rate-limit' {
  import type { RequestHandler } from 'express';
  interface Options {
    windowMs?: number;
    max?: number;
    standardHeaders?: boolean;
    legacyHeaders?: boolean;
    message?: object;
  }
  function rateLimit(opts?: Options): RequestHandler;
  export = rateLimit;
}

declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<any>;
}
