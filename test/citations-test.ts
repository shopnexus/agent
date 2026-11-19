/** Offline: sources from server's MCP result shapes — kind, label, meta and facts per kind; one source per record; data sources. */
import assert from 'node:assert/strict';
import { SourceBook, findRecords, dropUnknownMarkers, shortId, type Source } from '../src/run/citations';

const A = '019a1b2c-0000-7000-8000-0000007d22e9', B = '019a1b2c-0000-7000-8000-00000000b0b0';
const T = '019a1b2c-0000-7000-8000-00000000c1c1', O = '019a1b2c-0000-7000-8000-00000000d1d1', L = '019a1b2c-0000-7000-8000-00000000e1e1';
const M = '01a1ef31-726a-7a4a-859b-1641cfff0c3e', X = '01a1ef31-72ae-770b-8f29-176de0a5d47b';
const now = new Date('2026-11-18T12:00:00Z');
const text = (v: unknown) => [{ text: JSON.stringify(v) }];
const pick = (s: Pick<Source, 'kind' | 'label' | 'meta' | 'facts'>) => ({ kind: s.kind, label: s.label, meta: s.meta, facts: s.facts });

function main() {
  assert.equal(shortId(A), '7d22e9', 'the last six characters: UUIDv7 ids share their first ones');

  // The live bug: console_actions on member records. Each action is a log source with a name; target ids are no source.
  const book = new SourceBook();
  const actions = book.add('console_actions', 'call-1', text({ items: [
    { action: 'member.create', actor_kind: 'cli', actor_name: 'root', at: '2026-11-18T15:05:57Z', details: { role: 'admin' }, id: X, target_id: M, target_kind: 'member' },
    { action: 'account.suspend', actor_kind: 'member', actor_name: 'Trang', member_id: B, at: '2026-11-17T09:00:00Z', details: { reason: 'Lừa đảo', days: 7 }, id: O, target_id: A, target_kind: 'account' },
  ] }), { label: 'Console actions', input: {} });
  assert.deepEqual(actions.map(pick), [
    { kind: 'log', label: 'member.create by root', meta: 'Console action · 2026-11-18 · member',
      facts: [{ label: 'Action', value: 'member.create' }, { label: 'Target', value: `member ${shortId(M)}` }, { label: 'By', value: 'root (cli)' }, { label: 'At', value: '2026-11-18' }] },
    { kind: 'log', label: 'account.suspend by Trang', meta: 'Console action · 2026-11-17 · account',
      facts: [{ label: 'Action', value: 'account.suspend' }, { label: 'Target', value: `account ${shortId(A)}` }, { label: 'By', value: 'Trang (member)' }, { label: 'At', value: '2026-11-17' }] },
    { kind: 'member', label: 'Trang', meta: `Console member · ${shortId(B)}`, facts: [] },
  ]);
  assert.equal(actions[1].quote, 'Lừa đảo');
  assert.ok(!actions.some(s => s.record_id === M), 'a bare reference id is not a source');

  // Accounts: a list yields one source per account; account_get reads the same one fuller and keeps its number.
  const accounts = book.add('accounts_list', 'call-2', text({ items: [
    { id: A, display_name: 'Shop Hoa', status: 'active', created_at: '2026-01-02T00:00:00Z' },
    { id: B, display_name: 'Bảo', status: 'suspended', suspended_until: '2026-11-25T00:00:00Z', suspend_reason: 'Hàng giả', created_at: '2026-03-01T00:00:00Z' },
  ], total: 2 }));
  assert.deepEqual(accounts.map(s => [s.n, s.kind, s.label, s.meta]), [[4, 'account', 'Shop Hoa', `Account · ${shortId(A)} · active`], [5, 'account', 'Bảo', `Account · ${shortId(B)} · suspended`]]);
  assert.deepEqual(accounts[1].facts, [{ label: 'Status', value: 'suspended' }, { label: 'Suspended until', value: '2026-11-25' }, { label: 'Joined', value: '2026-03-01' }]);
  const full = book.add('account_get', 'call-3', text({ id: A, display_name: 'Shop Hoa', status: 'active', created_at: '2026-01-02T00:00:00Z', age_days: 320,
    has_phone: true, has_email: false, listings: { on_sale: 12, public: 10, sold: 40 }, orders_as_buyer: { placed: 1, failed: 0, open: 0 }, suspensions: 0 }));
  assert.equal(full[0].n, 4, 'a record seen again keeps its number');
  assert.deepEqual(full[0].facts, [{ label: 'Status', value: 'active' }, { label: 'Age', value: '320 days' }, { label: 'On sale', value: '12' }, { label: 'Suspensions', value: '0' }]);
  assert.equal(book.sources[3].facts.length, 4, 'the fuller reading replaces the facts');

  // Tickets: the request's title; the person is an account source (Customer); messages are not records.
  const tickets = findRecords({ id: T, kind: 'carrier_request', status: 'open', opened_at: '2026-11-16T08:00:00Z', person: { id: A, display_name: 'Shop Hoa', deleted: false },
    person_status: 'active', carrier_name: 'GHN', messages: [{ id: X, from: 'person', automatic: false, text: 'Cho tôi đổi sang GHN', photos: 0, at: '2026-11-16T08:00:00Z' }],
    other_tickets: [{ id: O, kind: 'not_received', status: 'resolved', opened_at: '2026-10-01T00:00:00Z' }],
    order: { id: L, title: 'Áo khoác', price: 350000, status: 'shipped', seller: { id: B, display_name: 'Bảo', deleted: false } } }, 'ticket_get');
  assert.deepEqual(tickets.map(s => [s.kind, s.label, s.meta]), [
    ['ticket', 'Carrier request · GHN', 'Ticket · carrier request · open'],
    ['account', 'Shop Hoa', `Customer · ${shortId(A)}`],
    ['ticket', 'Not received, 2026-10-01', 'Ticket · not received · resolved'],
    ['order', 'Order: Áo khoác', 'Order · shipped · 350.000 ₫'],
    ['account', 'Bảo', `Seller · ${shortId(B)}`],
  ]);
  assert.equal(tickets[0].quote, 'Cho tôi đổi sang GHN');
  const [other] = findRecords({ id: O, kind: 'other', status: 'open', opened_at: '2026-11-19T00:00:00Z', more_messages: false,
    messages: [{ id: X, from: 'shopnexus', text: 'Chào bạn' }, { id: X, from: 'person', text: 'Tôi muốn đổi số điện thoại' }] }, 'ticket_get');
  assert.equal(other.label, 'Other request · Tôi muốn đổi số điện thoại', 'an other ticket is named by its first words');
  const [listed] = findRecords({ items: [{ id: T, kind: 'not_received', status: 'open', opened_at: '2026-11-19T00:00:00Z', order_title: 'Áo khoác', last_text: 'Chưa nhận' }] }, 'tickets_list');
  assert.equal(listed.label, 'Not received · Áo khoác');
  assert.deepEqual(tickets[0].facts, [{ label: 'Kind', value: 'carrier request' }, { label: 'Status', value: 'open' }, { label: 'Opened', value: '2026-11-16' }, { label: 'Carrier', value: 'GHN' }]);

  // Report cases (the case id is the account's) and the reports in them.
  const cases = findRecords({ items: [{ account_id: A, account: { id: A, display_name: 'Shop Hoa', status: 'active' }, reports: 3, reasons: { scam: 2, fake: 1 },
    listing_id: L, first_at: '2026-11-10T00:00:00Z', last_at: '2026-11-17T00:00:00Z' }], total: 1 }, 'report_cases_list');
  assert.deepEqual(cases.map(pick)[0], { kind: 'report', label: 'Report case: Shop Hoa', meta: '3 reports · scam · open',
    facts: [{ label: 'Reports', value: '3' }, { label: 'Reasons', value: 'scam, fake' }, { label: 'Last report', value: '2026-11-17' }, { label: 'First report', value: '2026-11-10' }] });
  assert.deepEqual(cases.map(s => s.kind), ['report', 'account']);
  assert.equal(cases[1].meta, `Reported account · ${shortId(A)} · active`);
  const got = findRecords({ account_id: A, account: { id: A, display_name: 'Shop Hoa', status: 'active' }, reasons: { scam: 1 }, first_at: '2026-11-10T00:00:00Z', last_at: '2026-11-10T00:00:00Z',
    resolution: { outcome: 'actioned', at: '2026-11-11T00:00:00Z', member_id: B, member: 'Trang' },
    listings: [{ id: L, title: 'iPhone 15 giá rẻ', price: 2000000, status: 'hidden' }],
    reports: [{ id: O, reporter_id: T, reporter: 'Minh', reason: 'scam', note: 'Bán xong không giao', at: '2026-11-10T00:00:00Z' }] }, 'report_case_get');
  assert.deepEqual(got.map(s => [s.kind, s.label, s.meta]), [
    ['report', 'Report case: Shop Hoa', '1 report · scam · actioned'],
    ['account', 'Shop Hoa', `Reported account · ${shortId(A)} · active`],
    ['member', 'Trang', `Console member · ${shortId(B)}`],
    ['listing', 'iPhone 15 giá rẻ', 'Listing · hidden · 2.000.000 ₫'],
    ['report', 'Report by Minh', 'Report · scam · 2026-11-10'],
  ]);
  assert.equal(got[0].quote, 'Bán xong không giao');

  // Orders and listings.
  const [ord] = findRecords({ id: O, code: 'SN-1042', status: 'completed', price: 250000, buyer_id: A, seller_id: B, listing_id: L, listing_title: 'Giày chạy bộ',
    shipment: { mode: 'linked', carrier: 'GHN', tracking_code: 'X1', status: 'delivered' } }, 'order_get');
  assert.deepEqual(pick(ord), { kind: 'order', label: 'Order: Giày chạy bộ', meta: 'Order SN-1042 · completed · 250.000 ₫',
    facts: [{ label: 'Status', value: 'completed' }, { label: 'Price', value: '250.000 ₫' }, { label: 'Shipment', value: 'GHN · delivered' }] });
  const [lst] = findRecords({ id: L, seller_id: B, title: 'Giày chạy bộ', price: 250000, description: 'Size 42, mới 90%', category_code: 'shoes', condition: 'used_good',
    status: 'active', province: 'Hà Nội', photo_urls: [], specs: [{ label: 'Size', value: '42' }], created_at: '2026-11-01T00:00:00Z' }, 'listing_get');
  assert.deepEqual(pick(lst), { kind: 'listing', label: 'Giày chạy bộ', meta: 'Listing · active · 250.000 ₫ · Hà Nội',
    facts: [{ label: 'Price', value: '250.000 ₫' }, { label: 'Status', value: 'active' }, { label: 'Condition', value: 'used_good' }, { label: 'Category', value: 'shoes' }] });
  assert.equal(lst.quote, 'Size 42, mới 90%');

  // Data sources: what was asked, the tool and its rows.
  const [count] = findRecords({ entity: 'reports', since: '2026-11-11T12:00:00Z', total: 9, by_status: { open: 6, resolved: 3 } }, 'count',
    { input: { entity: 'reports', since: '2026-11-11T12:00:00Z' }, label: 'Counts', now }, 'call-9');
  assert.deepEqual(pick(count), { kind: 'data', label: 'Reports, last 7 days', meta: 'count · 1 row',
    facts: [{ label: 'Total', value: '9' }, { label: 'Open', value: '6' }, { label: 'Resolved', value: '3' }] });
  assert.equal(count.record_id, 'call-9');
  const [empty] = findRecords({ items: [] }, 'tickets_list', { input: { status: 'open', limit: 20 }, label: 'Support tickets' });
  assert.deepEqual([empty.kind, empty.label, empty.meta], ['data', 'Support tickets, open', 'tickets_list · 0 rows']);
  const [suspended] = findRecords({ items: [], total: 0 }, 'accounts_list', { input: { suspended: true }, label: 'Accounts' });
  assert.equal(suspended.label, 'Accounts, suspended');
  const [guide] = findRecords({ listing_id: L, price: 250000, median: 300000, sample_size: 14 }, 'price_guide', { input: { listing_id: L }, label: 'Price guide' });
  assert.deepEqual([guide.label, guide.meta, guide.facts], ['Price guide', 'price_guide · 1 row', [{ label: 'Median', value: '300.000 ₫' }, { label: 'Sample', value: '14' }, { label: 'Price', value: '250.000 ₫' }]]);
  const [look] = findRecords({ id: A, matches: [{ kind: 'account', label: 'Shop Hoa, active', tool: 'account_get' }] }, 'lookup');
  assert.deepEqual([look.kind, look.label], ['account', 'Shop Hoa, active']);

  // No source anywhere reads "Record <id>".
  const all = [...book.sources, ...tickets, ...cases, ...got, ord, lst, count, empty, guide, look];
  assert.ok(all.every(s => !/^Record\b/.test(s.label) && !(s.record_id && s.label.includes(s.record_id))), 'labels are names, not ids');
  assert.equal(dropUnknownMarkers('A [1] and [99].', book), 'A [1] and.');
  console.log('Citation tests passed (log, member, account, ticket, report, order, listing and data sources; numbering and fuller readings)');
}
main();
