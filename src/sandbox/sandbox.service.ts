import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
  type InvokeCodeInterpreterCommandInput,
  type InvokeCodeInterpreterCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreClient } from '../aws/agentcore-client';
import { config } from '../config';

// Types derived from the SDK so the wire shapes stay in sync automatically.
type ToolArgs = NonNullable<InvokeCodeInterpreterCommandInput['arguments']>;
type Language = NonNullable<ToolArgs['language']>;
type StreamEvent =
  NonNullable<InvokeCodeInterpreterCommandOutput['stream']> extends AsyncIterable<infer E>
    ? E
    : never;
type Result = NonNullable<Extract<StreamEvent, { result?: unknown }>['result']>;

const SUPPORTED = ['python', 'javascript', 'typescript'] as const;

/**
 * AgentCore Code Interpreter — an isolated sandbox where the agent runs code.
 * One sandbox session is started lazily and reused for the process lifetime,
 * then stopped on shutdown. Exposed to the agent as the `run_code` tool.
 */
@Injectable()
export class SandboxService implements OnModuleDestroy {
  private readonly log = new Logger(SandboxService.name);
  private sessionId?: string;
  private starting?: Promise<string>;

  constructor(private readonly aws: AgentCoreClient) {}

  /** Strands tool the agent calls to execute code in the sandbox. */
  asTool() {
    return tool({
      name: 'run_code',
      description:
        'Execute code in a secure sandbox and return its stdout/stderr. ' +
        'Use for calculations, data work, or anything better solved by running code.',
      inputSchema: z.object({
        language: z.enum(SUPPORTED).default('python'),
        code: z.string().describe('Full source to execute.'),
      }),
      // zod guarantees `language` is one of SUPPORTED, a subset of Language.
      callback: async (input) => this.run(input.language, input.code),
    });
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (!this.starting) {
      this.starting = this.aws.client
        .send(
          new StartCodeInterpreterSessionCommand({
            codeInterpreterIdentifier: config.sandbox.code_interpreter_id,
            name: 'aws-agent-demo',
            sessionTimeoutSeconds: 900,
          }),
        )
        .then((res) => {
          if (!res.sessionId) throw new Error('no sessionId from StartCodeInterpreterSession');
          this.sessionId = res.sessionId;
          this.log.log(`sandbox session started: ${res.sessionId}`);
          return res.sessionId;
        });
    }
    return this.starting;
  }

  private async run(language: Language, code: string): Promise<string> {
    const sessionId = await this.ensureSession();
    const res = await this.aws.client.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: config.sandbox.code_interpreter_id,
        sessionId,
        name: 'executeCode',
        arguments: { language, code },
      }),
    );

    // The response body is an event stream; collect text/stdout from result events.
    let isError = false;
    const parts: string[] = [];
    const consume = (result: Result) => {
      if (result.isError) isError = true;
      const sc = result.structuredContent;
      if (sc?.stdout) parts.push(sc.stdout);
      if (sc?.stderr) parts.push(`[stderr] ${sc.stderr}`);
      if (typeof sc?.exitCode === 'number' && sc.exitCode !== 0) {
        parts.push(`[exitCode] ${sc.exitCode}`);
      }
      for (const c of result.content ?? []) {
        if (c.text) parts.push(c.text);
      }
    };

    for await (const event of res.stream ?? []) {
      if (event.result) consume(event.result);
    }

    const out = parts.join('\n').trim() || '(no output)';
    return isError ? `Execution error:\n${out}` : out;
  }

  async onModuleDestroy() {
    if (!this.sessionId) return;
    try {
      await this.aws.client.send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: config.sandbox.code_interpreter_id,
          sessionId: this.sessionId,
        }),
      );
    } catch {
      /* best-effort cleanup */
    }
  }
}
