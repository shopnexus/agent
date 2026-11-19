import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { errorDetails } from '../observability/error-details';

/** Error codes of the refusals before a run's stream starts. */
export type AgentErrorCode = 'unauthorized' | 'bad_request' | 'not_found' | 'agent_unavailable' | 'internal';

/** An HTTP error whose body is exactly `{code}`. */
export class AgentError extends HttpException {
  constructor(readonly code: AgentErrorCode, status: number) {
    super({ code }, status);
  }
  static unauthorized() { return new AgentError('unauthorized', HttpStatus.UNAUTHORIZED); }
  static badRequest() { return new AgentError('bad_request', HttpStatus.BAD_REQUEST); }
  static notFound() { return new AgentError('not_found', HttpStatus.NOT_FOUND); }
  static unavailable() { return new AgentError('agent_unavailable', HttpStatus.SERVICE_UNAVAILABLE); }
}

const codeByStatus: Record<number, AgentErrorCode> = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found' };

/** Every error leaves as `{code}`; Nest's own exceptions and crashes included. */
@Catch()
export class AgentErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('HttpError');
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    // A run's stream already started: its failures go in the stream, not as a status.
    if (res.headersSent) { this.log.error(JSON.stringify({ event: 'error_after_stream', ...errorDetails(error) })); res.end(); return; }
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
