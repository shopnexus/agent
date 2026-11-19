import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ServiceTokenGuard } from '../console/service-token.guard';
import { FeatureFlags } from '../guardrails/feature-flags';
import { AgentError } from '../http/agent-error';
import { parseRunRequest } from './run-request';
import type { RunLine } from './run-stream';
import { TurnRunner } from './turn-runner';

/** Writes one NDJSON line, waiting while the socket is full; a closed response drops it. */
function writeLine(res: Response, line: RunLine): Promise<void> | void {
  if (res.writableEnded || res.destroyed) return;
  if (res.write(JSON.stringify(line) + '\n')) return;
  return new Promise<void>(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** The runtime's only routes: one run segment per request, and a probe. */
@Controller()
export class RunsController {
  constructor(private readonly runner: TurnRunner) {}

  @Get('healthz')
  health() { return { ok: true }; }

  /**
   * Runs one segment and streams it back as NDJSON while it runs; the last line
   * is `end`. Closing the request aborts the segment.
   */
  @Post('runs')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  async run(@Body() body: unknown, @Res() res: Response): Promise<void> {
    if (!FeatureFlags.isAgentEnabled || !FeatureFlags.isLlmEnabled) throw AgentError.unavailable();
    const request = parseRunRequest(body);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const closed = new AbortController();
    res.on('close', () => { if (!res.writableFinished) closed.abort(); });
    await this.runner.run(request, line => writeLine(res, line), closed.signal);
    res.end();
  }
}
