import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { makeAgentScopeHarness } from './helpers/agent-scope-harness';
import { AuditLogService } from '../src/guardrails/audit-log.service';
import { withTraceContext } from '../src/observability/trace-context';
import { LlmService } from '../src/llm/llm.service';
import { config } from '../src/config';

async function main() {
  const records: any[] = [];
  const methods = ['log','warn','error'] as const;
  const originals = methods.map(method=>Logger.prototype[method]);
  for (const method of methods) Logger.prototype[method]=function(message: any) {
    if (typeof message==='string' && message.startsWith('{')) records.push(JSON.parse(message));
  };
  try {
    const a=makeAgentScopeHarness(), b=makeAgentScopeHarness();
    await Promise.all([
      a.service.chat('actor-a','conversation-a','PRIVATE_INPUT_A',{actorId:'actor-a'}),
      b.service.chat('actor-b','conversation-b','PRIVATE_INPUT_B',{actorId:'actor-b'}),
    ]);
    const completed=records.filter(row=>row.event==='chat_completed');
    assert.equal(completed.length,2,'every chat must have a correlated completion');
    const traces=new Set(completed.map(row=>row.trace_id));
    assert.equal(traces.size,2,'concurrent requests must not share a trace');
    for (const conversation of ['conversation-a','conversation-b']) {
      const events=records.filter(row=>row.conversation_id===conversation);
      assert(events.some(row=>row.event==='stage_completed' && row.stage==='generation'));
      assert(events.some(row=>row.event==='turn_completed' && row.turn_id==='turn' && row.status==='SUCCEEDED'));
      assert.equal(new Set(events.map(row=>row.trace_id)).size,1,'all stages must retain their request trace');
      assert(events.filter(row=>row.event==='stage_completed').every(row=>Number.isFinite(row.duration_ms) && row.duration_ms>=0));
    }
    records.length=0;
    const failed=makeAgentScopeHarness();
    (failed.agent as any).invoke=async()=>{throw Object.assign(new Error('PRIVATE_ERROR_BODY'),{cause:Object.assign(new Error('PRIVATE_CAUSE'),{code:'ECONNRESET'})});};
    await failed.service.chat('actor-a','conversation-failed','PRIVATE_INPUT_C',{actorId:'actor-a'});
    const error=records.find(row=>row.event==='stage_failed' && row.stage==='generation');
    assert(error,'generation exceptions need a stage-specific diagnostic');
    assert.equal(error.cause.code,'ECONNRESET');
    assert(error.trace_id && error.turn_id==='turn');
    assert(records.some(row=>row.event==='turn_completed' && row.status==='FAILED'));
    assert(!JSON.stringify(records).match(/PRIVATE_|Verified shopping answer/),'logs must not contain prompts, answers or raw errors');
    records.length=0;
    const preflight=makeAgentScopeHarness();
    preflight.turns.startTurn=async()=>{throw Object.assign(new Error('PRIVATE_DATABASE_ERROR'),{code:'P1001'});};
    await assert.rejects(preflight.service.chat('actor-a','conversation-preflight','PRIVATE_INPUT_D'));
    assert(records.some(row=>row.event==='stage_failed' && row.stage==='start_turn' && row.code==='P1001'));
    records.length=0;
    const requestTrace='00000000-0000-4000-8000-012345678901';
    withTraceContext({trace_id:requestTrace,conversation_id:'owned-conversation',turn_id:'owned-turn'},()=>{
      new AuditLogService().write({trace_id:'old-random-id',conversation_id:'owned-conversation',actor_id:'synthetic',user_type:'authenticated',event:'turn_error',status:'error',output_summary:'synthetic phone 0912345678',ts:new Date().toISOString()});
    });
    assert.equal(records[0].trace_id,requestTrace,'audit must preserve the internal trace even when UUID digits resemble PII');
    assert(!records[0].output_summary.includes('0912345678'),'audit content must still be masked');
    assert.equal(records[0].turn_id,'owned-turn');
    records.length=0;
    const originalFetch=globalThis.fetch;
    const originalGateway={...config.litellm};
    config.litellm.base_url='http://127.0.0.1:1/v1';
    config.litellm.api_key='synthetic-test-key';
    try {
      globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'PRIVATE_RESPONSE_BODY'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json','x-request-id':'req-synthetic'}});
      const llm=new LlmService();
      await withTraceContext({trace_id:'transport-trace',conversation_id:'transport-conversation'},()=>llm.classifyJson([{role:'user',content:'PRIVATE_PROMPT'}],new AbortController().signal));
      const completed=records.find(row=>row.event==='llm_request_completed');
      assert(completed,'successful transport needs duration and upstream request correlation');
      assert.equal(completed.requestId,'req-synthetic');
      assert.equal(completed.trace_id,'transport-trace');
      const started=records.find(row=>row.event==='llm_request_started');
      assert.equal(started.client_timeout_ms,config.agent.scope_timeout_ms,'log the configured SDK timeout');
      assert.equal(completed.finish_reason,'stop');
      records.length=0;
      globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'PRIVATE_PROVIDER_ERROR',type:'rate_limit_error',code:'rate_limit_exceeded'}}),{status:429,headers:{'content-type':'application/json','x-request-id':'req-rate-limit'}});
      await assert.rejects(llm.classifyJson([{role:'user',content:'PRIVATE_PROMPT'}],new AbortController().signal));
      const failure=records.find(row=>row.event==='llm_request_failed');
      assert.equal(failure.status,429);
      assert.equal(failure.code,'rate_limit_exceeded');
      assert.equal(failure.requestId,'req-rate-limit');
      assert(!JSON.stringify(records).match(/PRIVATE_|synthetic-test-key/));
    } finally {
      globalThis.fetch=originalFetch;
      Object.assign(config.litellm,originalGateway);
    }
  } finally {
    methods.forEach((method,index)=>{Logger.prototype[method]=originals[index] as any;});
  }
  console.log('Observability tests passed (request isolation, correlated stages, causes, persistence errors, no raw content)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
