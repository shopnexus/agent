import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { traceContext } from '../observability/trace-context';
import { errorDetails } from '../observability/error-details';
import { Agent, BeforeToolsEvent, BeforeToolCallEvent, AfterToolCallEvent, ToolResultEvent } from '@strands-agents/sdk';
import { TurnRepository, ToolEvent } from '../db/turn.repository';
export interface ToolCallTracker { flush():Promise<void> }
function snapshot(value:unknown,max:number):unknown {
  const scrub=(item:unknown,depth=0):unknown=>{
    if(depth>8)return '[depth limit]';
    if(typeof item==='string')return item.slice(0,max).replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi,'[redacted]');
    if(Array.isArray(item))return item.slice(0,100).map(x=>scrub(x,depth+1));
    if(item && typeof item==='object')return Object.fromEntries(Object.entries(item).slice(0,100).filter(([k])=>!/reasoning|chain.?of.?thought|signature/i.test(k)).map(([k,v])=>[k,/password|secret|token|api.?key|authorization|cookie/i.test(k)?'[redacted]':scrub(v,depth+1)]));
    return item ?? null;
  };
  const safe=scrub(value),text=JSON.stringify(safe);
  return text.length<=max?safe:{truncated:true,preview:text.slice(0,max-40)};
}
export function installToolCallTracker(agent:Agent,repository:TurnRepository,options:{turnId:string;conversationId?:string;ownedOutputIds?:ReadonlySet<string>;maxPayloadChars?:number;signal?:AbortSignal}):ToolCallTracker {
  const log=new Logger('ToolCall'),max=Math.max(128,Math.min(options.maxPayloadChars ?? 16000,64000));
  const context={...traceContext(),conversation_id:options.conversationId ?? traceContext().conversation_id,turn_id:options.turnId};
  const toolMetadata=(row:ToolEvent)=>({tool:/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(row.toolName)?row.toolName:'invalid_tool_name',
    // Some providers append an opaque thought signature to their ID. Never log it.
    tool_call_id:`tc_${createHash('sha256').update(row.toolUseId).digest('base64url')}`,
    toolUseIdLength:row.toolUseId.length,status:row.status});
  const calls=new Map<string,{row:ToolEvent;started:number;cancelled?:boolean}>();
  let queue=Promise.resolve(),failure:unknown;
  const persist=(row:ToolEvent)=>{
    const copy=structuredClone(row);
    const pending=queue.then(()=>repository.saveToolCall(copy));
    queue=pending.catch(error=>{
      failure=error;
      // Never log the raw Prisma message: it can include tool arguments/secrets.
      const details=error && typeof error==='object'?error as {name?:unknown;code?:unknown;message?:unknown;meta?:{code?:unknown}}:{};
      const message=typeof details.message==='string'?details.message:'';
      const unknownArgument=message.match(/Unknown argument `([A-Za-z_][A-Za-z0-9_]*)`/);
      const missingArgument=message.match(/Argument `([A-Za-z_][A-Za-z0-9_]*)` is missing/);
      const safeCode=(value:unknown)=>typeof value==='string' && /^[A-Za-z0-9_]{1,64}$/.test(value)?value:undefined;
      log.error(JSON.stringify({event:'tool_call_persistence_failed',...context,stage:'tool_audit',...toolMetadata(copy),
        ...errorDetails(error),
        reason:['Invalid tool identity','Cannot start tool after turn completion'].includes(message)?message:undefined,
        toolNameLength:copy.toolName.length,databaseCode:safeCode(details.meta?.code),
        unknownArgument:unknownArgument?.[1],missingArgument:missingArgument?.[1]}));
    });
    return pending;
  };
  const start=(use:{toolUseId:string;name:string;input:unknown})=>{
    if(calls.has(use.toolUseId))return calls.get(use.toolUseId)!;
    const raw=snapshot(use.input,max);
    const call:{row:ToolEvent;started:number;cancelled?:boolean}={row:{turnId:options.turnId,toolUseId:use.toolUseId,toolName:use.name,
      toolSource:use.name.startsWith('memory_')?'memory':use.name==='read_output'?'utility':'mcp',input:(raw && typeof raw==='object' && !Array.isArray(raw)?raw:{value:raw}) as Record<string,unknown>,status:'pending'},started:Date.now()};
    calls.set(use.toolUseId,call);return call;
  };
  agent.addHook(BeforeToolsEvent,async event=>{
    if(options.signal?.aborted){event.cancel='Turn cancelled';return;}
    for(const block of event.message.content)if(block.type==='toolUseBlock') {
      if(calls.has(block.toolUseId))throw new Error('Duplicate tool_use_id in turn');
      await persist(start(block).row);
    }
  });
  agent.addHook(BeforeToolCallEvent,async event=>{
    const call=start(event.toolUse);
    if(options.signal?.aborted)event.cancel='Turn cancelled';
    call.cancelled=!!event.cancel;call.row.status='running';await persist(call.row);
    log.log(JSON.stringify({event:'tool_call_started',...context,...toolMetadata(call.row),cancelled:call.cancelled}));
  },{order:100});
  const complete=async (useId:string,status:string,content:unknown)=>{
    const call=calls.get(useId);if(!call)return;
    call.row.status=call.cancelled?'cancelled':status==='success'?'success':'failed';
    call.row.latencyMs=Date.now()-call.started;
    const bounded=snapshot(content,max);
    call.row.content=Array.isArray(bounded)?bounded:[{text:JSON.stringify(bounded)}];
    call.row.output=JSON.stringify(bounded).slice(0,max);
    call.row.outputSpilled=[...(options.ownedOutputIds ?? [])].some(id=>JSON.stringify(content).includes(id));
    await persist(call.row);
    log.log(JSON.stringify({event:'tool_call_completed',...context,...toolMetadata(call.row),duration_ms:call.row.latencyMs}));
  };
  agent.addHook(AfterToolCallEvent,async event=>{await complete(event.toolUse.toolUseId,event.result.status,event.result.toJSON().toolResult.content);},{order:100});
  agent.addHook(ToolResultEvent,async event=>{
    const call=calls.get(event.result.toolUseId);
    if(call && ['pending','running'].includes(call.row.status))await complete(event.result.toolUseId,event.result.status,event.result.toJSON().toolResult.content);
  });
  return {flush:async()=>{await queue;if(failure)throw failure;}};
}
