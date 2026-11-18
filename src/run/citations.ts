export type SourceKind = 'report' | 'account' | 'ticket' | 'order' | 'listing' | 'data' | 'log';

/** A numbered source of a turn: one record a tool returned. */
export interface Source {
  n: number; kind: SourceKind; record_id: string; label: string; quote: string; call_id: string; tool: string;
}

const MAX_PER_CALL = 20;
const MAX_PER_TURN = 200;
const QUOTE_CHARS = 200;
const QUOTE_FIELDS = ['title', 'subject', 'summary', 'reason', 'body', 'text', 'message', 'content', 'description', 'note', 'name', 'display_name', 'status'];
const LABEL_FIELDS = ['title', 'subject', 'display_name', 'name'];
const KIND_WORDS: Array<[RegExp, SourceKind]> = [
  [/report|case/, 'report'],
  [/ticket/, 'ticket'],
  [/order/, 'order'],
  [/listing|product/, 'listing'],
  [/log|audit|action|trace/, 'log'],
  [/account|user|seller|buyer|member|shop|actor/, 'account'],
];
const KIND_NAMES: Record<SourceKind, string> = {
  report: 'Report', account: 'Account', ticket: 'Ticket', order: 'Order', listing: 'Listing', data: 'Record', log: 'Log',
};

export function kindOf(word: string): SourceKind {
  const w = word.toLowerCase();
  return KIND_WORDS.find(([re]) => re.test(w))?.[1] ?? 'data';
}

function clean(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function firstString(item: Record<string, unknown>, fields: string[]): string {
  for (const f of fields) {
    const v = item[f];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

interface Found { kind: SourceKind; id: string; label: string; quote: string }

/**
 * Records in a tool result: each object with an `id` is a record (its kind from
 * the key holding it, else the tool's name) with a quoted line from its text
 * fields; each `*_id` value is a referenced record without a quote.
 */
export function findRecords(value: unknown, tool: string): Found[] {
  const found = new Map<string, Found>();
  const add = (f: Found) => {
    const key = `${f.kind}:${f.id}`;
    const prior = found.get(key);
    if (!prior) found.set(key, f);
    else if (!prior.quote && f.quote) found.set(key, { ...prior, quote: f.quote, label: f.label });
  };
  const walk = (item: unknown, context: string, depth: number) => {
    if (depth > 6 || found.size >= MAX_PER_CALL * 2) return;
    if (Array.isArray(item)) { for (const x of item) walk(x, context, depth + 1); return; }
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id === 'string' && obj.id.length <= 64) {
      const kind = kindOf(context);
      const named = firstString(obj, LABEL_FIELDS);
      add({ kind, id: obj.id, quote: clean(firstString(obj, QUOTE_FIELDS), QUOTE_CHARS),
        label: named ? clean(named, 80) : `${KIND_NAMES[kind]} ${obj.id.slice(0, 8)}` });
    }
    for (const [key, v] of Object.entries(obj)) {
      const ref = /^([a-z0-9]+(?:_[a-z0-9]+)*)_id$/.exec(key);
      if (ref && typeof v === 'string' && v.length <= 64) {
        const kind = kindOf(ref[1]);
        add({ kind, id: v, quote: '', label: `${KIND_NAMES[kind]} ${v.slice(0, 8)}` });
      } else if (v && typeof v === 'object') walk(v, key, depth + 1);
    }
  };
  walk(value, tool, 0);
  // Records with their own text first: they are what the result is about.
  return [...found.values()].sort((a, b) => Number(!!b.quote) - Number(!!a.quote)).slice(0, MAX_PER_CALL);
}

/** Parses a tool result's content blocks into JSON values. */
export function contentJson(content: ReadonlyArray<unknown>): unknown[] {
  return content.flatMap(block => {
    const b = block as { text?: unknown; json?: unknown };
    if (b.json !== undefined) return [b.json];
    if (typeof b.text === 'string') { try { return [JSON.parse(b.text)]; } catch { return []; } }
    return [];
  });
}

/**
 * Numbers the records a turn's tools returned, in the order results arrive.
 * A record seen again keeps its first number. Carried in the run state, so a
 * continued turn goes on numbering where it stopped.
 */
export class SourceBook {
  constructor(private readonly list: Source[] = []) {}

  get sources(): Source[] { return this.list.map(s => ({ ...s })); }

  /** Numbers the records of one successful call; returns this call's sources. */
  add(tool: string, callId: string, content: ReadonlyArray<unknown>): Source[] {
    const records = findRecords(contentJson(content), tool);
    const out: Source[] = [];
    for (const r of records) {
      let source = this.list.find(s => s.kind === r.kind && s.record_id === r.id);
      if (!source) {
        if (this.list.length >= MAX_PER_TURN) break;
        source = { n: this.list.length + 1, kind: r.kind, record_id: r.id, label: r.label, quote: r.quote, call_id: callId, tool };
        this.list.push(source);
      }
      out.push({ ...source });
    }
    return out;
  }

  has(n: number): boolean { return this.list.some(s => s.n === n); }
}

/** The header put in front of a tool result so the model knows which number to cite. */
export function sourceHeader(sources: Source[]): string {
  if (!sources.length) return '';
  const lines = sources.map(s => `[${s.n}] ${s.kind} ${s.record_id}${s.quote ? ` "${s.quote}"` : ''}`);
  return `Sources in this result (cite as [n] in the answer):\n${lines.join('\n')}\n\n`;
}

/** Drops `[n]` markers that point at no source of the turn. */
export function dropUnknownMarkers(markdown: string, book: Pick<SourceBook, 'has'>): string {
  return markdown
    .replace(/\[(\d{1,4})\]/g, (marker, n) => book.has(Number(n)) ? marker : '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}
