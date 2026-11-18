import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { errorDetails } from '../observability/error-details';

/** Error codes the console path (server) maps to its own codes. */
export type AgentErrorCode =
  | 'unauthorized' | 'bad_request' | 'input_rejected' | 'not_found'
  | 'turn_in_progress' | 'conversation_closed' | 'turn_state' | 'skill_exists' | 'forbidden'
  | 'rate_limited' | 'agent_budget' | 'agent_timeout' | 'agent_unavailable' | 'internal';

/** An HTTP error whose body is exactly `{code}`. */
export class AgentError extends HttpException {
  constructor(readonly code: AgentErrorCode, status: number) {
    super({ code }, status);
  }
  static unauthorized() { return new AgentError('unauthorized', HttpStatus.UNAUTHORIZED); }
  static badRequest() { return new AgentError('bad_request', HttpStatus.BAD_REQUEST); }
  static notFound() { return new AgentError('not_found', HttpStatus.NOT_FOUND); }
  static turnInProgress() { return new AgentError('turn_in_progress', HttpStatus.CONFLICT); }
  static closed() { return new AgentError('conversation_closed', HttpStatus.CONFLICT); }
  /** The turn is not in a state that takes this action (pause a paused turn, continue a finished one). */
  static turnState() { return new AgentError('turn_state', HttpStatus.CONFLICT); }
  static skillExists() { return new AgentError('skill_exists', HttpStatus.CONFLICT); }
  static forbidden() { return new AgentError('forbidden', HttpStatus.FORBIDDEN); }
  static budget() { return new AgentError('agent_budget', HttpStatus.TOO_MANY_REQUESTS); }
  static timeout() { return new AgentError('agent_timeout', HttpStatus.GATEWAY_TIMEOUT); }
  static unavailable() { return new AgentError('agent_unavailable', HttpStatus.SERVICE_UNAVAILABLE); }
}

const codeByStatus: Record<number, AgentErrorCode> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 429: 'rate_limited',
};

/** Every error leaves as `{code}`; Nest's own exceptions and crashes included. */
@Catch()
export class AgentErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpError');
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof AgentError) { res.status(error.getStatus()).json({ code: error.code }); return; }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      res.status(status).json({ code: codeByStatus[status] ?? (status < 500 ? 'bad_request' : 'internal') });
      return;
    }
    // Never log the raw message: it can carry request data.
    this.log.error(JSON.stringify({ event: 'unhandled_error', ...errorDetails(error) }));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ code: 'internal' });
  }
}
