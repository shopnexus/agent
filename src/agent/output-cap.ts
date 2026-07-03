import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  Agent,
  AfterToolCallEvent,
  ToolResultBlock,
  toolResultContentFromData,
  tool,
} from '@strands-agents/sdk';
import { z } from 'zod';

/**
 * Bounds tool output that enters the model context. Large tool results (code
 * stdout, big MCP payloads) are truncated to head+tail with a notice, and the
 * full text is spilled to a temp file the agent can page through on demand via
 * the `read_output` tool. Deterministic capping at the tool boundary — the
 * model can't be trusted to self-limit, and full grep-by-default is fragile.
 */

const log = new Logger('OutputCap');
const SPILL_DIR = path.join(os.tmpdir(), 'agentcore-tool-output');
const HEAD_FRACTION = 0.8; // keep mostly head, some tail (errors cluster at the end)
const ID_RE = /^[a-zA-Z0-9-]+$/;

type ResultContent = NonNullable<ToolResultBlock['content']>;
type ResultBlock = ResultContent[number];

/** Register the capping hook on an agent. Call once per agent instance. */
export function installOutputCap(agent: Agent, cap: number): void {
  agent.addHook(AfterToolCallEvent, (event) => {
    const result = event.result;
    if (!result?.content?.length) return;

    const full = result.content.map(blockText).join('');
    if (full.length <= cap) return;

    const id = spill(full);
    const headN = Math.floor(cap * HEAD_FRACTION);
    const tailN = cap - headN;
    const notice =
      `\n\n…[truncated: ${full.length} chars, showing ${headN}+${tailN}. ` +
      `Full output id="${id}" — call read_output(id) to page through it.]…\n\n`;
    const truncated = full.slice(0, headN) + notice + full.slice(full.length - tailN);

    // `content` is read-only, so replace the result with a fresh block (content
    // items are class instances with toJSON, so build one via the SDK helper).
    event.result = new ToolResultBlock({
      toolUseId: result.toolUseId,
      status: result.status,
      content: [toolResultContentFromData({ text: truncated })],
    });
  });
}

/** The `read_output` tool: page through a spilled tool output deterministically. */
export function readOutputTool() {
  return tool({
    name: 'read_output',
    description:
      'Read a previously truncated tool output by its id. Page with offset/limit ' +
      '(line-based), or jump near the first line containing `contains`.',
    inputSchema: z.object({
      id: z.string().describe('The id from a "[truncated …]" notice.'),
      offset: z.number().int().min(0).default(0).describe('First line (0-based).'),
      limit: z.number().int().min(1).max(1000).default(200).describe('How many lines.'),
      contains: z.string().optional().describe('Jump to the first line containing this text.'),
    }),
    callback: async (input) => readOutput(input),
  });
}

function readOutput(input: {
  id: string;
  offset: number;
  limit: number;
  contains?: string;
}): string {
  if (!ID_RE.test(input.id)) return 'error: invalid id';
  const file = path.join(SPILL_DIR, `${input.id}.txt`);
  if (!fs.existsSync(file)) return `error: output "${input.id}" not found (may have expired)`;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let start = input.offset;
  if (input.contains) {
    const found = lines.findIndex((l) => l.includes(input.contains!));
    start = found >= 0 ? Math.max(0, found - 5) : input.offset;
  }
  const end = Math.min(lines.length, start + input.limit);
  const header = `lines ${start}-${end - 1} of ${lines.length}`;
  return `[${header}]\n${lines.slice(start, end).join('\n')}`;
}

function blockText(block: ResultBlock): string {
  if (block && typeof block === 'object') {
    if ('text' in block && typeof block.text === 'string') return block.text;
    if ('json' in block && block.json !== undefined) return JSON.stringify(block.json);
  }
  return '';
}

function spill(text: string): string {
  const id = randomUUID();
  try {
    fs.mkdirSync(SPILL_DIR, { recursive: true });
    fs.writeFileSync(path.join(SPILL_DIR, `${id}.txt`), text);
  } catch (e) {
    log.warn(`spill failed: ${(e as Error).message}`);
  }
  return id;
}
