import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { Prisma, TurnStatus, ToolCallStatus } from '@prisma/client';
import type { StoredConversationTurn } from '../memory/conversation-context.service';
import { AgentError } from '../http/agent-error';
import { visibleTo } from './conversation.repository';
import type { Source } from '../run/citations';
import type { AnswerBlock } from '../run/answer-blocks';
import type { RunState } from '../run/run-state';

export interface ToolEvent {
  turnId:string; toolUseId:string; toolName:string; toolSource?:string;
  input:Record<string,unknown>; status:ToolCallStatus; output?:string;
  content?:unknown; outputSpilled?:boolean; latencyMs?:number;
  /** The tool_calls row id, chosen by the caller so events can name it before the row exists. */
  id?:string; attempts?:number; timing?:Record<string,unknown>; finishedAt?:Date;
}
export type FinishStatus = 'SUCCEEDED'|'FAILED'|'CANCELLED'|'TIMED_OUT';
export interface FinishParams {
  turnId:string; status:FinishStatus; answer:string; sources?:Source[]; blocks?:AnswerBlock[]; latencyMs:number;
  errorCode?:string; stopReason?:string; inputTokens?:number; outputTokens?:number;
  costUsd?:number; firstTokenMs?:number; provider?:string; state?:RunState;
}
export interface RunUsageColumns { inputTokens?:number; outputTokens?:number; costUsd?:number; firstTokenMs?:number; provider?:string }

/** A turn still owning its conversation: running, paused or waiting for the member. */
export const UNFINISHED:TurnStatus[] = ['RUNNING','PAUSED','AWAITING_INPUT','AWAITING_APPROVAL'];
const TERMINAL = ['success','failed','cancelled'];

function json(value:unknown):Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function usageData(u:RunUsageColumns) {
  return {
    ...(u.inputTokens !== undefined ? {inputTokens:BigInt(Math.max(0,u.inputTokens))} : {}),
    ...(u.outputTokens !== undefined ? {outputTokens:BigInt(Math.max(0,u.outputTokens))} : {}),
    ...(u.costUsd !== undefined ? {costUsd:new Prisma.Decimal(Math.max(0,u.costUsd).toFixed(6))} : {}),
    ...(u.firstTokenMs !== undefined ? {firstTokenMs:Math.max(0,Math.round(u.firstTokenMs))} : {}),
    ...(u.provider !== undefined ? {provider:u.provider.slice(0,128)} : {}),
  };
}

@Injectable()
export class TurnRepository {
  constructor(private readonly prisma:PrismaService) {}

  /** Lock the conversation the member may see and open a RUNNING turn asked by them. */
  async startTurn(params:{conversationId:string;memberId:string;userText:string;modelId:string;agentId?:string;agentName?:string;deadlineMs?:number;state?:RunState}) {
    try {
      return await this.prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{id:string;status:string;title:string|null}>>`
          SELECT id,status,title FROM conversations
          WHERE id=${params.conversationId}::uuid AND (subject_kind IS NOT NULL OR actor_id=${params.memberId}) FOR UPDATE`;
        if (!rows.length) throw AgentError.notFound();
        if (rows[0].status !== 'active') throw AgentError.closed();
        if (await tx.turn.findFirst({where:{conversationId:params.conversationId,status:{in:UNFINISHED}}})) throw AgentError.turnInProgress();
        const previous = await tx.turn.aggregate({where:{conversationId:params.conversationId},_max:{ordinal:true}});
        const turn = await tx.turn.create({data:{conversationId:params.conversationId,memberId:params.memberId,ordinal:(previous._max.ordinal ?? -1)+1,modelId:params.modelId,
          agentId:params.agentId,agentName:params.agentName,deadlineMs:params.deadlineMs,...(params.state ? {state:json(params.state)} : {}),
          messages:{create:{ordinal:0,role:'USER',blocks:{create:{ordinal:0,eventSeq:1n,kind:'TEXT',text:params.userText}}}}}});
        await tx.conversation.update({where:{id:params.conversationId},data:{lastActivityAt:new Date(),
          ...(rows[0].title === null ? {title:params.userText.slice(0,80)} : {})}});
        return {id:turn.id,ordinal:turn.ordinal};
      });
    } catch(error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw AgentError.turnInProgress();
      throw error;
    }
  }

  async statusOf(turnId:string):Promise<string|null> {
    return (await this.prisma.turn.findUnique({where:{id:turnId},select:{status:true}}))?.status ?? null;
  }

  /** The turn if its conversation is visible to the member; null otherwise. */
  findVisible(turnId:string,memberId:string) {
    return this.prisma.turn.findFirst({where:{id:turnId,conversation:visibleTo(memberId)}});
  }

  /** True when no later turn exists in the conversation. */
  async isLatest(turnId:string):Promise<boolean> {
    const turn = await this.prisma.turn.findUnique({where:{id:turnId},select:{conversationId:true,ordinal:true}});
    if (!turn) return false;
    return !(await this.prisma.turn.findFirst({where:{conversationId:turn.conversationId,ordinal:{gt:turn.ordinal}},select:{id:true}}));
  }

  /** Saves the run state of a running turn; returns false when it is no longer running. */
  async checkpoint(turnId:string,state:RunState):Promise<boolean> {
    return (await this.prisma.turn.updateMany({where:{id:turnId,status:'RUNNING'},data:{state:json(state)}})).count === 1;
  }

  /** RUNNING -> PAUSED or AWAITING_INPUT with the state to continue from. */
  async suspend(turnId:string,status:'PAUSED'|'AWAITING_INPUT',state:RunState,usage:RunUsageColumns,latencyMs:number):Promise<boolean> {
    return (await this.prisma.turn.updateMany({where:{id:turnId,status:'RUNNING'},
      data:{status,state:json(state),latencyMs:BigInt(Math.max(0,Math.round(latencyMs))),...usageData(usage)}})).count === 1;
  }

  /**
   * Makes a turn RUNNING again for a new run segment, under the turn's lock.
   * From FAILED or TIMED_OUT, `allowTerminal` must say yes; the failed run's
   * terminal answer is removed, since the continued run writes its own.
   */
  async claim(turnId:string,from:TurnStatus[],deadlineMs:number,allowTerminal?:(turn:{status:string;errorCode:string|null;state:unknown;latest:boolean})=>boolean) {
    return this.prisma.$transaction(async tx => {
      const locked = await this.lockTurn(tx,turnId);
      if (!from.includes(locked.status as TurnStatus)) return null;
      const turn = await tx.turn.findUniqueOrThrow({where:{id:turnId}});
      const terminal = !UNFINISHED.includes(turn.status);
      if (terminal) {
        const later = await tx.turn.findFirst({where:{conversationId:turn.conversationId,ordinal:{gt:turn.ordinal}},select:{id:true}});
        if (!allowTerminal?.({status:turn.status,errorCode:turn.errorCode,state:turn.state,latest:!later})) return null;
        // Another unfinished turn may have opened meanwhile.
        if (await tx.turn.findFirst({where:{conversationId:turn.conversationId,status:{in:UNFINISHED}},select:{id:true}})) return null;
        await tx.message.deleteMany({where:{turnId,role:'ASSISTANT',blocks:{some:{isTerminal:true}}}});
      }
      return tx.turn.update({where:{id:turnId},data:{status:'RUNNING',runStartedAt:new Date(),deadlineMs,finishedAt:null,errorCode:null,errorMessage:null}});
    });
  }

  /** A member's message inside a turn: steering or answers to questions. */
  async addUserBlock(turnId:string,text:string,payload:Record<string,unknown>) {
    await this.prisma.$transaction(async tx => {
      const turn = await this.lockTurn(tx,turnId);
      await tx.message.create({data:{turnId,conversationId:turn.conversationId,ordinal:await this.nextMessage(tx,turnId),role:'USER',
        blocks:{create:{ordinal:0,eventSeq:1n,kind:'TEXT',text,payload:json(payload)}}}});
    });
  }

  /** Close an unfinished turn with its terminal answer; a terminal turn is left as it is. Returns whether it closed it. */
  async finishTurn(params:FinishParams):Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const turn = await this.lockTurn(tx,params.turnId);
      if (!UNFINISHED.includes(turn.status as TurnStatus)) return false;
      const ordinal = await this.nextMessage(tx,params.turnId);
      await tx.message.create({data:{turnId:params.turnId,conversationId:turn.conversationId,ordinal,role:'ASSISTANT',
        blocks:{create:{ordinal:0,eventSeq:1n,kind:'TEXT',text:params.answer,isTerminal:true,
          payload:json({sources:params.sources ?? [],blocks:params.blocks ?? []})}}}});
      // Counters are run totals: a continued turn carries them on.
      await tx.turn.update({where:{id:params.turnId},data:{status:params.status,finishedAt:new Date(),latencyMs:BigInt(Math.max(0,Math.round(params.latencyMs))),
        errorCode:params.errorCode ?? null, stopReason:params.stopReason?.slice(0,32),
        ...usageData({inputTokens:params.inputTokens,outputTokens:params.outputTokens,costUsd:params.costUsd,firstTokenMs:params.firstTokenMs,provider:params.provider}),
        ...(params.state ? {state:json(params.state)} : {})}});
      await tx.conversation.update({where:{id:turn.conversationId},data:{lastActivityAt:new Date()}});
      return true;
    });
  }

  /** Prior terminal turns of a conversation, newest first. The caller has checked access. */
  async getRecentMessages(conversationId:string,limit:number,beforeOrdinal?:number):Promise<StoredConversationTurn[]> {
    return this.prisma.turn.findMany({where:{conversationId,status:{notIn:UNFINISHED},...(beforeOrdinal === undefined ? {} : {ordinal:{lt:beforeOrdinal}})},
      orderBy:{ordinal:'desc'},take:Math.max(1,Math.min(limit,50)),include:{messages:{orderBy:{ordinal:'asc'},include:{blocks:{orderBy:{ordinal:'asc'}}}}}});
  }

  /** RUNNING turns whose current run segment passed its deadline plus the grace: left by a crash or a lost finish. */
  findStuck(now:Date,graceMs:number,limit=100) {
    return this.prisma.$queryRaw<Array<{id:string;runStartedAt:Date;startedAt:Date;wrote:boolean}>>`
      SELECT id, run_started_at AS "runStartedAt", started_at AS "startedAt", COALESCE((state->>'wrote')::boolean, false) AS wrote FROM turns
      WHERE status = 'RUNNING' AND run_started_at < ${now}::timestamptz - make_interval(secs => (deadline_ms + ${graceMs}) / 1000.0)
      ORDER BY run_started_at LIMIT ${limit}`;
  }

  /** A tool call with its input, output and timing, if the member may see its turn. */
  findToolCall(id:string,memberId:string) {
    return this.prisma.toolCall.findFirst({where:{id,turn:{conversation:visibleTo(memberId)}}});
  }

  /** Each call event atomically writes audit + transcript under the turn lock. Late results never change turn state. */
  async saveToolCall(event:ToolEvent):Promise<void> {
    if (!event.toolUseId.trim() || !event.toolName.trim() || event.toolName.length>128) throw new Error('Invalid tool identity');
    // Provider IDs may exceed VARCHAR(64). Hash, never truncate, so IDs with a
    // shared prefix remain distinct. Use the same bounded identity for audit
    // and transcript, without mutating the live SDK event/result pairing.
    if (event.toolUseId.length>64) event = {...event,toolUseId:`tc_${createHash('sha256').update(event.toolUseId).digest('base64url')}`};
    await this.prisma.$transaction(async tx => {
      const turn = await this.lockTurn(tx,event.turnId);
      const identity = {turnId: event.turnId,toolUseId:event.toolUseId};
      const prior = await tx.toolCall.findUnique({where:{turnId_toolUseId:identity}});
      // Retries cannot regress a completed execution to running/pending.
      if (prior && TERMINAL.includes(prior.status) && ['pending','running'].includes(event.status)) return;
      const data = {
        toolName:event.toolName,
        toolSource:event.toolSource,
        input:event.input as Prisma.InputJsonObject,
        status:event.status,
        output:event.output,
        outputSpilled:event.outputSpilled ?? prior?.outputSpilled ?? false,
        latencyMs:event.latencyMs,
        ...(event.attempts !== undefined ? {attempts:event.attempts} : {}),
        ...(event.timing !== undefined ? {timing:json(event.timing)} : {}),
        ...(event.finishedAt !== undefined ? {finishedAt:event.finishedAt} : {}) };
      await tx.toolCall.upsert({where:{turnId_toolUseId:identity},create:{...identity,...(event.id ? {id:event.id} : {}),...data},update:data});
      let message = await tx.message.findFirst({where:{turnId:event.turnId,blocks:{some:{kind:'TOOL_USE',toolUseId:event.toolUseId}}}});
      if (!message) {
        // A genuinely new call may not start after the turn has finished.
        if (!UNFINISHED.includes(turn.status as TurnStatus)) throw new Error('Cannot start tool after turn completion');
        message = await tx.message.create({data:{turnId:event.turnId,conversationId:turn.conversationId,ordinal:await this.nextMessage(tx,event.turnId),role:'ASSISTANT',
          blocks:{create:{ordinal:0,eventSeq:1n,kind:'TOOL_USE',toolUseId:event.toolUseId,toolName:event.toolName,payload:event.input as Prisma.InputJsonObject}}}});
      }
      if (TERMINAL.includes(event.status)) {
        const payload = {status:event.status === 'success' ? 'success':'error',content:event.content ?? [{text:event.output ?? 'Tool unavailable'}]};
        await tx.messageBlock.upsert({where:{messageId_eventSeq:{messageId:message.id,eventSeq:2n}},
          create:{messageId:message.id,ordinal:1,eventSeq:2n,kind:'TOOL_RESULT',toolUseId:event.toolUseId,payload:payload as Prisma.InputJsonObject},
          update:{payload:payload as Prisma.InputJsonObject}});
      }
    });
  }
  private async lockTurn(tx:Prisma.TransactionClient,id:string) {
    const rows = await tx.$queryRaw<Array<{conversationId:string;status:string}>>`SELECT conversation_id AS "conversationId",status FROM turns WHERE id=${id}::uuid FOR UPDATE`;
    if (!rows.length) throw AgentError.notFound();
    return rows[0];
  }
  private async nextMessage(tx:Prisma.TransactionClient,turnId:string):Promise<number> {
    return ((await tx.message.aggregate({where:{turnId},_max:{ordinal:true}}))._max.ordinal ?? -1)+1;
  }
}
