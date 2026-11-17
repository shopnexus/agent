import { Agent, AfterToolCallEvent } from '@strands-agents/sdk';
import type { TurnSource } from '../db/turn.repository';

const MAX_IDS = 20;
const ID_KEY = /^(id|ids|[a-z0-9]+_ids?|[a-z0-9]+Ids?)$/;

/**
 * Record ids found in a tool result: the string values of `id`, `*_id`,
 * `ids` and `*_ids` keys at any depth, in order, without duplicates.
 */
export function resultIds(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (item: unknown, depth: number, idKey: boolean) => {
    if (found.size >= MAX_IDS || depth > 6) return;
    if (typeof item === 'string') { if (idKey && item.length <= 64) found.add(item); return; }
    if (Array.isArray(item)) { for (const x of item) walk(x, depth + 1, idKey); return; }
    if (item && typeof item === 'object') {
      for (const [key, v] of Object.entries(item)) walk(v, depth + 1, ID_KEY.test(key));
    }
  };
  walk(value, 0, false);
  return [...found].slice(0, MAX_IDS);
}

function contentJson(content: ReadonlyArray<unknown>): unknown[] {
  return content.flatMap(block => {
    const b = block as { text?: unknown; json?: unknown };
    if (b.json !== undefined) return [b.json];
    if (typeof b.text === 'string') { try { return [JSON.parse(b.text)]; } catch { return []; } }
    return [];
  });
}

/**
 * Collects a source per finished (successful) MCP tool call of this turn.
 * Runs before the output cap so ids are read from the whole result.
 */
export function installSourceCollector(agent: Agent, labels: ReadonlyMap<string, string>): () => TurnSource[] {
  const sources: TurnSource[] = [];
  agent.addHook(AfterToolCallEvent, event => {
    const name = event.toolUse?.name;
    if (!name || !labels.has(name) || event.result?.status !== 'success') return;
    const ids = resultIds(contentJson(event.result.content ?? []));
    const key = JSON.stringify([name, ids]);
    if (sources.some(s => JSON.stringify([s.tool, s.ids]) === key)) return;
    sources.push({ tool: name, label: labels.get(name)!, ids });
  }, { order: -200 });
  return () => sources.map(s => ({ ...s, ids: [...s.ids] }));
}
