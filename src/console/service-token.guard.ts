import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config';
import { AgentError } from '../http/agent-error';

/** Constant-time comparison of two secrets of any length; an empty expected secret matches nothing. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
}

/** Lets a request through only with `Authorization: Bearer <AGENT_SERVICE_TOKEN>`. */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly log = new Logger(ServiceTokenGuard.name);
  constructor() {
    if (!config.console.service_token) this.log.warn('AGENT_SERVICE_TOKEN is empty: every run is refused');
  }
  canActivate(context: ExecutionContext): boolean {
    const auth = context.switchToHttp().getRequest<Request>().header('authorization') ?? '';
    const bearer = /^Bearer (.+)$/.exec(auth)?.[1] ?? '';
    if (!sameSecret(bearer, config.console.service_token)) throw AgentError.unauthorized();
    return true;
  }
}
