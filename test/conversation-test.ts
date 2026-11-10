import assert from 'node:assert/strict';
import { ConversationContextService } from '../src/memory/conversation-context.service';

const blocks = (kind: string, extra: any = {}, ordinal = 0) => ({ kind, ordinal, isTerminal: false, ...extra });
const turns: any[] = [{ ordinal: 1, status: 'SUCCEEDED', messages: [
  { ordinal: 2, role: 'ASSISTANT', blocks: [blocks('TEXT', {text: 'verified', isTerminal: true})] },
  { ordinal: 0, role: 'USER', blocks: [blocks('TEXT', {text: 'question'})] },
  { ordinal: 1, role: 'ASSISTANT', blocks: [
    blocks('TEXT', {text: 'unverified progress'}),
    blocks('THINKING', {text: 'never replay'}),
    blocks('TOOL_USE', {toolUseId:'a',toolName:'get_product',payload:{productId:'PROD-1'}},2),
    blocks('TOOL_RESULT', {toolUseId:'a',payload:{status:'success',content:[{text:'evidence'}]}},3),
    blocks('TOOL_RESULT', {toolUseId:'orphan',payload:{status:'success',content:[{text:'bad'}]}},4),
  ] },
]}];
const history = new ConversationContextService().build(turns, 40);
assert.deepEqual(history.map(m => m.role), ['user','assistant','user','assistant']);
assert.deepEqual(history[0].content, [{text:'question'}]);
assert.deepEqual(history[3].content, [{text:'verified'}]);
assert(!JSON.stringify(history).match(/never replay|unverified progress|orphan/));
const failed = new ConversationContextService().build([{...turns[0], status:'TIMED_OUT'}],40);
assert.match(JSON.stringify(failed), /TIMED_OUT/);
assert.equal(new ConversationContextService().build(turns, 1).length,0);
const separated = structuredClone(turns);
const toolMessage = separated[0].messages.find((m: any) => m.ordinal === 1);
const resultBlocks = toolMessage.blocks.filter((b: any) => b.kind === 'TOOL_RESULT');
toolMessage.blocks = toolMessage.blocks.filter((b: any) => b.kind !== 'TOOL_RESULT');
separated[0].messages.push({ordinal: 1.5, role:'ASSISTANT', blocks:resultBlocks});
assert.deepEqual(new ConversationContextService().build(separated,40), history, 'pair tools across messages in a turn');
console.log('conversation context tests passed');
