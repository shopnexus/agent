import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { Prisma, TurnStatus, ToolCallStatus } from '@prisma/client';
import type { StoredConversationTurn } from '../memory/conversation-context.service';
import { AgentError } from '../http/agent-error';

/** A source chip: one tool the turn read, with the record ids it returned. */
export interface TurnSource { tool: string; label: string; ids: string[] }
export const TURN_LIMIT = 50;

export interface ToolEvent {
  turnId:string; toolUseId:string; toolName:string; toolSource?:string;
  input:Record<string,unknown>; status:ToolCallStatus; output?:string;
  content?:unknown; outputSpilled?:boolean; latencyMs?:number;
}
const unfinished:TurnStatus[] = ['RUNNING','AWAITING_INPUT','AWAITING_APPROVAL'];
@Injectable()
export class TurnRepository {
  constructor(private readonly prisma:PrismaService) {}

  /** Lock the conversation the member may see and open a RUNNING turn asked by them. */
  async startTurn(params:{conversationId:string;memberId:string;userText:string;modelId:string}) {
    try {
      return await this.prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{id:string;status:string;title:string|null}>>`
          SELECT id,status,title FROM conversations
          WHERE id=${params.conversationId}::uuid AND (subject_kind IS NOT NULL OR actor_id=${params.memberId}) FOR UPDATE`;
        if (!rows.length) throw AgentError.notFound();
        if (rows[0].status !== 'active') throw AgentError.closed();
        if (await tx.turn.findFirst({where:{conversationId:params.conversationId,status:{in:unfinished}}})) throw AgentError.turnInProgress();
        // Enforce under the same lock too: the caller's count can become stale.
        if (await tx.turn.count({where:{conversationId:params.conversationId}}) >= TURN_LIMIT) throw AgentError.turnLimit();
        const previous = await tx.turn.aggregate({where:{conversationId:params.conversationId},_max:{ordinal:true}});
        const turn = await tx.turn.create({data:{conversationId:params.conversationId,memberId:params.memberId,ordinal:(previous._max.ordinal ?? -1)+1,modelId:params.modelId,
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

  /** Close an unfinished turn with its terminal answer; a terminal turn is left as it is. */
  async finishTurn(params:{turnId:string;status:'SUCCEEDED'|'FAILED'|'CANCELLED'|'TIMED_OUT';answer:string;sources?:TurnSource[];latencyMs:number;errorCode?:string;stopReason?:string;inputTokens?:number;outputTokens?:number}) {
    await this.prisma.$transaction(async tx => {
      const turn = await this.lockTurn(tx,params.turnId);
      if (!unfinished.includes(turn.status as TurnStatus)) return;
      const ordinal = await this.nextMessage(tx,params.turnId);
      await tx.message.create({data:{turnId:params.turnId,conversationId:turn.conversationId,ordinal,role:'ASSISTANT',
        blocks:{create:{ordinal:0,eventSeq:1n,kind:'TEXT',text:params.answer,isTerminal:true,
          payload:{sources:(params.sources ?? []) as unknown as Prisma.InputJsonArray}}}}});
      await tx.turn.update({where:{id:params.turnId},data:{status:params.status,finishedAt:new Date(),latencyMs:BigInt(Math.max(0,params.latencyMs)),
        errorCode:params.errorCode, stopReason:params.stopReason?.slice(0,32), inputTokens:BigInt(params.inputTokens ?? 0), outputTokens:BigInt(params.outputTokens ?? 0)}});
      await tx.conversation.update({where:{id:turn.conversationId},data:{lastActivityAt:new Date()}});
    });
  }

  /** Prior terminal turns of a conversation, newest first. The caller has checked access. */
  async getRecentMessages(conversationId:string,limit:number,beforeOrdinal?:number):Promise<StoredConversationTurn[]> {
    return this.prisma.turn.findMany({where:{conversationId,status:{notIn:unfinished},...(beforeOrdinal === undefined ? {} : {ordinal:{lt:beforeOrdinal}})},
      orderBy:{ordinal:'desc'},take:Math.max(1,Math.min(limit,50)),include:{messages:{orderBy:{ordinal:'asc'},include:{blocks:{orderBy:{ordinal:'asc'}}}}}});
  }
  getTurnCount(conversationId:string):Promise<number> {
    // An unfinished 50th turn must reach startTurn's conflict check, not look
    // like 50 completed turns to the service's friendly limit precheck.
    return this.prisma.turn.count({where:{conversationId,status:{notIn:unfinished}}});
  }

  /** RUNNING turns started before the cutoff: past their deadline, left by a crash or a lost finish. */
  findRunningBefore(cutoff:Date,limit=100) {
    return this.prisma.turn.findMany({where:{status:'RUNNING',startedAt:{lt:cutoff}},select:{id:true,startedAt:true},orderBy:{startedAt:'asc'},take:limit});
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
      if (prior && ['success','failed','cancelled'].includes(prior.status) && ['pending','running'].includes(event.status)) return;
      const data = {
        toolName:event.toolName,
        toolSource:event.toolSource,
        input:event.input as Prisma.InputJsonObject,
        status:event.status,
        output:event.output,
        outputSpilled:event.outputSpilled ?? prior?.outputSpilled ?? false,
        latencyMs:event.latencyMs };
      await tx.toolCall.upsert({where:{turnId_toolUseId:identity},create:{...identity,...data},update:data});
      let message = await tx.message.findFirst({where:{turnId:event.turnId,blocks:{some:{kind:'TOOL_USE',toolUseId:event.toolUseId}}}});
      if (!message) {
        // A genuinely new call may not start after the turn has finished.
        if (!unfinished.includes(turn.status as TurnStatus)) throw new Error('Cannot start tool after turn completion');
        message = await tx.message.create({data:{turnId:event.turnId,conversationId:turn.conversationId,ordinal:await this.nextMessage(tx,event.turnId),role:'ASSISTANT',
          blocks:{create:{ordinal:0,eventSeq:1n,kind:'TOOL_USE',toolUseId:event.toolUseId,toolName:event.toolName,payload:event.input as Prisma.InputJsonObject}}}});
      }
      if (['success','failed','cancelled'].includes(event.status)) {
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
