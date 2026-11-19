/** The loop detector and PII masking in audit logs. */
import assert from 'node:assert/strict';
import { LoopDetector, LoopDetectedError } from '../src/guardrails/loop-detector';
import { scanAndMaskPii } from '../src/guardrails/pii-utils';

const loops = new LoopDetector();
loops.record('ticket_get', { ticket_id: 'a' });
loops.record('ticket_get', { ticket_id: 'a' });
loops.record('ticket_get', { ticket_id: 'b' });
assert.throws(() => loops.record('ticket_get', { ticket_id: 'a' }), LoopDetectedError);
assert.ok(!scanAndMaskPii('gọi 0912345678').masked.includes('0912345678'));
console.log('Guardrail tests passed (loop detector, PII masking)');
