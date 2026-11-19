export type SourceKind = 'account' | 'ticket' | 'report' | 'order' | 'listing' | 'member' | 'log' | 'data';

export interface SourceFact { label: string; value: string }

/** A numbered source of a turn: one record a tool returned, or one aggregate (kind data). */
export interface Source {
  n: number; kind: SourceKind; record_id: string;
  /** The record's human name: a display name, a listing title, a ticket's request. Never an id. */
  label: string;
  /** One short line of facts, such as "Seller · 7d22e9 · active". */
  meta: string;
  /** Up to four facts picked from the tool result for this record. */
  facts: SourceFact[];
  /** A line the record's people wrote, cut to 200 characters; empty when there is none. */
  quote: string;
  call_id: string; tool: string;
}

export interface CallContext {
  /** The tool's input, for a data source's label. */
  input?: unknown;
  /** The tool's MCP title. */
  label?: string;
  now?: Date;
}

type Found = Omit<Source, 'n' | 'call_id' | 'tool'>;
type Obj = Record<string, any>;

const MAX_PER_CALL = 20;
const MAX_PER_TURN = 200;
const QUOTE_CHARS = 200;
const MAX_FACTS = 4;

function clean(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
/** The last six characters of an id: UUIDv7 ids share their first ones. */
export const shortId = (id: string) => id.replace(/-/g, '').slice(-6);
const words = (v: string) => v.replace(/[_.]/g, ' ');
const capital = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const date = (v: unknown) => { const s = str(v); if (!s) return undefined; const t = Date.parse(s); return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10); };
const price = (v: unknown) => { const n = num(v); return n === undefined ? undefined : `${n.toLocaleString('vi-VN')} ₫`; };
const line = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');
function facts(...pairs: Array<[string, string | number | undefined]>): SourceFact[] {
  return pairs.filter(([, v]) => v !== undefined && v !== '').slice(0, MAX_FACTS).map(([label, v]) => ({ label, value: String(v) }));
}
const quoteOf = (...values: unknown[]) => clean(values.map(str).find(Boolean) ?? '', QUOTE_CHARS);
/** The reasons map of a report case, most reported first: "scam" or "scam, fake". */
function topReasons(reasons: unknown, n = 2): string | undefined {
  if (!reasons || typeof reasons !== 'object') return undefined;
  const sorted = Object.entries(reasons as Record<string, number>).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([r]) => r);
  return sorted.length ? sorted.slice(0, n).join(', ') : undefined;
}

/** How an account reads in the place it appears: the key that holds it. */
const ROLES: Record<string, string> = {
  seller: 'Seller', buyer: 'Buyer', person: 'Customer', account: 'Reported account', counterpart: 'Counterpart',
};

function account(o: Obj, key: string): Found {
  const name = o.deleted ? 'Deleted account' : str(o.display_name) ?? 'Unnamed account';
  return {
    kind: 'account', record_id: o.id, label: name,
    meta: line(ROLES[key] ?? 'Account', shortId(o.id), str(o.status) ?? str(o.person_status)),
    facts: facts(['Status', str(o.status)], ['Age', num(o.age_days) !== undefined ? `${o.age_days} days` : undefined],
      ['On sale', num(o.listings?.on_sale)], ['Suspensions', num(o.suspensions)], ['Suspended until', date(o.suspended_until)],
      ['Joined', date(o.created_at) ?? date(o.joined_at)]),
    quote: quoteOf(o.suspend_reason),
  };
}

/**
 * A ticket by its request, as the ticket's card heads it: "Carrier request ·
 * GHN", "Not received · Áo khoác", or the first words the person wrote.
 */
function ticketTitle(o: Obj, kind: string): string {
  // Only an other request is named by what the person wrote.
  const first = kind === 'other' && !o.more_messages && Array.isArray(o.messages) ? str([...o.messages].reverse().find((m: Obj) => m?.from === 'person')?.text) : undefined;
  const about = str(o.carrier_name) ?? str(o.order?.title) ?? str(o.order_title) ?? (first && clean(first, 60));
  const head = kind === 'other' ? 'Other request' : capital(kind);
  return about ? `${head} · ${about}` : `${head}${date(o.opened_at) ? `, ${date(o.opened_at)}` : ''}`;
}

function ticket(o: Obj): Found {
  const kind = str(o.kind) ? words(o.kind) : 'ticket';
  return {
    kind: 'ticket', record_id: o.id,
    label: ticketTitle(o, kind),
    meta: line('Ticket', kind, str(o.status)),
    facts: facts(['Kind', kind], ['Status', str(o.status)], ['Opened', date(o.opened_at)], ['Carrier', str(o.carrier_name)],
      ['Last message', date(o.last_message_at)], ['As', str(o.as)]),
    quote: quoteOf(o.last_text, o.messages?.find?.((m: Obj) => m.from === 'person')?.text),
  };
}

function order(o: Obj): Found {
  const title = str(o.listing_title) ?? str(o.title);
  return {
    kind: 'order', record_id: o.id,
    label: title ? `Order: ${title}` : str(o.code) ? `Order ${o.code}` : 'Order',
    meta: line(str(o.code) ? `Order ${o.code}` : 'Order', str(o.status), price(o.price)),
    facts: facts(['Status', str(o.status)], ['Price', price(o.price)],
      ['Shipment', line(str(o.shipment?.carrier) ?? str(o.carrier), str(o.shipment?.status) ?? str(o.shipment_status)) || undefined],
      ['Requested', date(o.requested_at)], ['Closed', date(o.closed_at)]),
    quote: quoteOf(o.cancel_reason),
  };
}

function listing(o: Obj): Found {
  return {
    kind: 'listing', record_id: o.id, label: clean(str(o.title) ?? 'Untitled listing', 120),
    meta: line('Listing', str(o.status), price(o.price), str(o.province)),
    facts: facts(['Price', price(o.price)], ['Status', str(o.status)], ['Condition', str(o.condition)], ['Category', str(o.category_code)],
      ['Province', str(o.province)], ['Published', date(o.published_at)]),
    quote: quoteOf(o.description),
  };
}

function reportCase(o: Obj): Found {
  const name = o.account && !o.account.deleted ? str(o.account.display_name) : undefined;
  const reports = num(o.reports) ?? (Array.isArray(o.reports) ? o.reports.length : undefined);
  const state = o.resolution ? str(o.resolution.outcome) ?? 'resolved' : 'open';
  return {
    kind: 'report', record_id: o.account_id,
    label: name ? `Report case: ${name}` : 'Report case',
    meta: line(reports !== undefined ? `${reports} report${reports === 1 ? '' : 's'}` : undefined, topReasons(o.reasons, 1), state),
    facts: facts(['Reports', reports], ['Reasons', topReasons(o.reasons, 3)], ['Last report', date(o.last_at)],
      ['Resolved by', str(o.resolution?.member)], ['First report', date(o.first_at)]),
    quote: quoteOf(Array.isArray(o.reports) ? o.reports.find((r: Obj) => str(r.note))?.note : undefined),
  };
}

function report(o: Obj): Found {
  return {
    kind: 'report', record_id: o.id, label: str(o.reporter) ? `Report by ${o.reporter}` : 'Report',
    meta: line('Report', str(o.reason), date(o.at)),
    facts: facts(['Reason', str(o.reason)], ['At', date(o.at)]),
    quote: quoteOf(o.note),
  };
}

function action(o: Obj): Found {
  const by = str(o.actor_name);
  return {
    kind: 'log', record_id: o.id, label: `${o.action}${by ? ` by ${by}` : ''}`,
    meta: line('Console action', date(o.at), str(o.target_kind)),
    facts: facts(['Action', str(o.action)], ['Target', str(o.target_id) ? `${o.target_kind ?? 'record'} ${shortId(o.target_id)}` : undefined],
      ['By', by ? `${by} (${o.actor_kind ?? 'member'})` : undefined], ['At', date(o.at)],
      ...Object.entries(o.details ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'number').slice(0, 2)
        .map(([k, v]) => [capital(words(k)), v as string | number] as [string, string | number])),
    quote: quoteOf(o.details?.reason),
  };
}

function member(id: string, name: string, role?: string): Found {
  return { kind: 'member', record_id: id, label: name, meta: line(role ?? 'Console member', shortId(id)), facts: [], quote: '' };
}

const LOOKUP_KINDS: Record<string, SourceKind> = { account: 'account', report_case: 'report', order: 'order', listing: 'listing', ticket: 'ticket' };

/** What one object of a tool result is, or nothing: messages, specs and aggregates are not records. */
function classify(o: Obj, key: string): Found | undefined {
  const id = str(o.id);
  if (str(o.account_id) && (o.reasons || Array.isArray(o.reports) || num(o.reports) !== undefined)) return reportCase(o);
  if (!id || id.length > 64) return undefined;
  if (str(o.action) && 'target_kind' in o) return action(o);
  if ('from' in o && 'text' in o) return undefined;
  if (str(o.reporter) !== undefined || ('reason' in o && 'reporter_id' in o)) return report(o);
  if ('display_name' in o) return account(o, key);
  if ('opened_at' in o && 'kind' in o) return ticket(o);
  if ('code' in o || 'listing_title' in o || key === 'order' || (key === 'orders' && 'price' in o)) return order(o);
  if ('title' in o) return listing(o);
  return undefined;
}

/** A data source's label: the tool's title and what was asked ("Reports, last 7 days"). */
function asked(tool: string, ctx: CallContext): string {
  const input = (ctx.input && typeof ctx.input === 'object' ? ctx.input : {}) as Obj;
  const now = (ctx.now ?? new Date()).getTime();
  const head = str(input.entity) ? capital(words(input.entity)) : ctx.label ?? capital(words(tool));
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === 'entity' || k === 'cursor' || k === 'limit' || /(^id$|_id$|^q$)/.test(k)) continue;
    if (k === 'since' && str(v)) {
      const days = Math.round((now - Date.parse(v as string)) / 86_400_000);
      parts.push(Number.isFinite(days) && days > 0 ? `last ${days} day${days === 1 ? '' : 's'}` : `since ${date(v)}`);
    } else if (v === true) parts.push(words(k));
    else if (str(v)) parts.push(words(v as string));
  }
  return parts.length ? `${head}, ${parts.join(', ')}` : head;
}

function dataSource(tool: string, value: unknown, ctx: CallContext, callId: string): Found {
  const top = (value && typeof value === 'object' ? value : {}) as Obj;
  const list = Array.isArray(top) ? top : Object.values(top).find(v => Array.isArray(v)) as unknown[] | undefined;
  const rows = list ? list.length : 1;
  const byStatus = top.by_status && typeof top.by_status === 'object' ? Object.entries(top.by_status as Record<string, number>) : [];
  return {
    kind: 'data', record_id: callId, label: asked(tool, ctx),
    meta: `${tool} · ${rows} row${rows === 1 ? '' : 's'}`,
    facts: facts(['Total', num(top.total)], ['Median', price(top.median)], ['Sample', num(top.sample_size)], ['Price', price(top.price)],
      ...byStatus.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, c]) => [capital(words(s)), c] as [string, number])),
    quote: '',
  };
}

/**
 * The records in a tool result, one source each: accounts, tickets, report
 * cases and reports, orders, listings, console actions (log) and the console
 * members named in them. A result with no record (a count, a price guide, an
 * empty list, a lookup that found nothing) is one data source for the call.
 */
export function findRecords(value: unknown, tool: string, ctx: CallContext = {}, callId = ''): Found[] {
  const found = new Map<string, Found>();
  const add = (f: Found) => {
    const key = `${f.kind}:${f.record_id}`;
    const prior = found.get(key);
    if (!prior || f.facts.length > prior.facts.length) found.set(key, prior ? { ...f, quote: f.quote || prior.quote } : f);
  };
  const walk = (item: unknown, key: string, depth: number) => {
    if (depth > 6 || found.size >= MAX_PER_CALL * 2) return;
    if (Array.isArray(item)) { for (const x of item) walk(x, key, depth + 1); return; }
    if (!item || typeof item !== 'object') return;
    const o = item as Obj;
    if (Array.isArray(o.matches) && str(o.id)) {
      for (const m of o.matches as Obj[]) {
        const kind = LOOKUP_KINDS[m.kind] ?? 'data';
        if (str(m.label)) add({ kind, record_id: o.id, label: clean(m.label, 120), meta: line(capital(words(m.kind ?? 'record')), shortId(o.id)), facts: facts(['Read with', str(m.tool)]), quote: '' });
      }
      return;
    }
    const record = classify(o, key);
    if (record) add(record);
    if (str(o.actor_kind) === 'member' && str(o.member_id) && str(o.actor_name)) add(member(o.member_id, o.actor_name));
    if (str(o.member_id) && str(o.member) && 'outcome' in o) add(member(o.member_id, o.member));
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') walk(v, k, depth + 1);
  };
  for (const v of Array.isArray(value) ? value : [value]) walk(v, tool, 0);
  const records = [...found.values()].slice(0, MAX_PER_CALL);
  if (records.length) return records;
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? [] : [dataSource(tool, first, ctx, callId)];
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
 * A record seen again keeps its first number; a fuller reading of it (more
 * facts, as from a *_get tool) replaces its label, meta and facts. Carried
 * in the run state, so a continued turn goes on numbering where it stopped.
 */
export class SourceBook {
  constructor(private readonly list: Source[] = []) {}

  get sources(): Source[] { return this.list.map(s => ({ ...s, facts: [...(s.facts ?? [])] })); }

  /** Numbers the records of one successful call; returns this call's sources. */
  add(tool: string, callId: string, content: ReadonlyArray<unknown>, ctx: CallContext = {}): Source[] {
    const values = contentJson(content);
    const records = findRecords(values.length === 1 ? values[0] : values, tool, ctx, callId);
    const out: Source[] = [];
    for (const r of records) {
      let source = r.kind === 'data' ? undefined : this.list.find(s => s.kind === r.kind && s.record_id === r.record_id);
      if (!source) {
        if (this.list.length >= MAX_PER_TURN) break;
        source = { n: this.list.length + 1, ...r, call_id: callId, tool };
        this.list.push(source);
      } else if (r.facts.length > (source.facts?.length ?? 0)) {
        Object.assign(source, { label: r.label, meta: r.meta, facts: r.facts, quote: r.quote || source.quote });
      }
      out.push({ ...source, facts: [...source.facts] });
    }
    return out;
  }

  has(n: number): boolean { return this.list.some(s => s.n === n); }
}

/** The header put in front of a tool result so the model knows which number to cite. */
export function sourceHeader(sources: Source[]): string {
  if (!sources.length) return '';
  const lines = sources.map(s => `[${s.n}] ${s.kind} "${s.label}" (${s.meta})${s.quote ? ` "${s.quote}"` : ''}`);
  return `Sources in this result (cite as [n] in the answer):\n${lines.join('\n')}\n\n`;
}

/** The source numbers `[n]` the texts cite. */
export function citedNumbers(texts: string[]): Set<number> {
  const cited = new Set<number>();
  for (const t of texts) for (const m of t.matchAll(/\[(\d{1,4})\]/g)) cited.add(Number(m[1]));
  return cited;
}

/** Drops `[n]` markers that point at no source of the turn. */
export function dropUnknownMarkers(markdown: string, book: Pick<SourceBook, 'has'>): string {
  return markdown
    .replace(/\[(\d{1,4})\]/g, (marker, n) => book.has(Number(n)) ? marker : '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}
