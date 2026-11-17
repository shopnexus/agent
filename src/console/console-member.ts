import { CanActivate, ExecutionContext, Injectable, Logger, createParamDecorator } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config';
import { AgentError } from '../http/agent-error';

export type ConsoleRole = 'moderator' | 'admin';

/** The console member server2 forwards; set only by ConsoleMemberGuard. */
export interface ConsoleMember { id: string; role: ConsoleRole }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES: ReadonlySet<string> = new Set(['moderator', 'admin']);
const MEMBER = Symbol('consoleMember');

/** Constant-time comparison of two secrets of any length. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return expected.length > 0 && timingSafeEqual(digest(given), digest(expected));
}

/**
 * Reads the member from a request forwarded by server2: the bearer must be
 * AGENT_SERVICE_TOKEN, and X-Console-Member / X-Console-Role must be valid.
 * With no token configured every request is refused.
 */
export function readConsoleMember(header: (name: string) => string | undefined, token = config.console.service_token): ConsoleMember {
  const auth = header('authorization') ?? '';
  const bearer = /^Bearer (.+)$/.exec(auth)?.[1] ?? '';
  if (!sameSecret(bearer, token)) throw AgentError.unauthorized();
  const id = header('x-console-member')?.trim() ?? '';
  const role = header('x-console-role')?.trim() ?? '';
  if (!UUID.test(id) || !ROLES.has(role)) throw AgentError.unauthorized();
  return { id: id.toLowerCase(), role: role as ConsoleRole };
}

@Injectable()
export class ConsoleMemberGuard implements CanActivate {
  private readonly log = new Logger(ConsoleMemberGuard.name);
  constructor() {
    if (!config.console.service_token) this.log.warn('AGENT_SERVICE_TOKEN is empty: every request is refused');
  }
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { [MEMBER]?: ConsoleMember }>();
    req[MEMBER] = readConsoleMember(name => req.header(name));
    return true;
  }
}

/** The guarded request's member. */
export const Member = createParamDecorator((_: unknown, context: ExecutionContext): ConsoleMember => {
  const member = context.switchToHttp().getRequest<{ [MEMBER]?: ConsoleMember }>()[MEMBER];
  if (!member) throw AgentError.unauthorized();
  return member;
});
