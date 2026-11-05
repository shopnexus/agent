import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import type { MessageData } from '@strands-agents/sdk';
import type { StoredConversationTurn } from '../memory/conversation-context.service';

export interface TurnRecord {
  id: string;
  sessionId: string;
  actorId: string;
  turnIndex: number;
  inputText: string | null;
  outputText: string | null;
  stopReason: string | null;
  modelId: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

export interface ToolCallRecord {
  id: string;
  turnId: string;
  toolUseId: string;
  toolName: string;
  toolSource: string | null;
  input: Record<string, unknown>;
  output: string | null;
  outputSpilled: boolean;
  status: string;
  latencyMs: number | null;
  createdAt: Date;
}

@Injectable()
export class TurnRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persist a completed turn (after agent.invoke resolves). */
  async saveTurn(params: {
    sessionId: string;
    actorId: string;
    turnIndex: number;
    inputText: string;
    outputText: string;
    stopReason?: string;
    modelId?: string;
    latencyMs?: number;
    messages?: MessageData[];
  }): Promise<TurnRecord> {
    const { sessionId, actorId, turnIndex, inputText, outputText, stopReason, modelId, latencyMs, messages = [] } = params;
    const t = await this.prisma.turn.create({
      data: {
        sessionId,
        actorId,
        turnIndex,
        inputText,
        outputText,
        stopReason: stopReason ?? null,
        modelId: modelId ?? null,
        latencyMs: latencyMs ?? null,
        messages: {
          create: messages.map((message) => ({
            sessionId,
            role: message.role,
            content: message.content.filter((block) => !('reasoning' in block)) as any,
          })),
        },
      },
    });
    return {
      id: t.id,
      sessionId: t.sessionId,
      actorId: t.actorId,
      turnIndex: t.turnIndex,
      inputText: t.inputText,
      outputText: t.outputText,
      stopReason: t.stopReason,
      modelId: t.modelId,
      latencyMs: t.latencyMs,
      createdAt: t.createdAt,
    };
  }

  /** Load recent completed transcript messages only for the session owner. */
  async getRecentMessages(sessionId: string, actorId: string, limit: number): Promise<StoredConversationTurn[]> {
    const rows = await this.prisma.turn.findMany({
      where: { sessionId, actorId, outputText: { not: null } },
      orderBy: { turnIndex: 'desc' },
      take: Math.max(1, Math.min(limit, 50)),
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return rows.reverse().map((turn) => ({
      turnIndex: turn.turnIndex,
      messages: turn.messages.length
        ? turn.messages.map((message) => ({
            role: message.role as MessageData['role'],
            content: message.content as unknown as MessageData['content'],
          }))
        : [
            ...(turn.inputText ? [{ role: 'user' as const, content: [{ text: turn.inputText }] }] : []),
            ...(turn.outputText ? [{ role: 'assistant' as const, content: [{ text: turn.outputText }] }] : []),
          ],
    }));
  }

  /** Get the current turn count for a session (used to set turn_index). */
  async getTurnCount(sessionId: string): Promise<number> {
    return this.prisma.turn.count({
      where: { sessionId },
    });
  }

  /** Persist a tool call that happened within a turn. */
  async saveToolCall(params: {
    turnId: string;
    toolUseId: string;
    toolName: string;
    toolSource?: string;
    input: Record<string, unknown>;
    output?: string;
    outputSpilled?: boolean;
    status?: string;
    latencyMs?: number;
  }): Promise<void> {
    const { turnId, toolUseId, toolName, toolSource, input, output, outputSpilled, status, latencyMs } = params;
    await this.prisma.toolCall.create({
      data: {
        turnId,
        toolUseId,
        toolName,
        toolSource: toolSource ?? null,
        input: input as any,
        output: output ?? null,
        outputSpilled: outputSpilled ?? false,
        status: status ?? 'success',
        latencyMs: latencyMs ?? null,
      },
    });
  }
}
