import type { ChatReply } from './agent/agent.service';

/** Render only the already verified final answer, once. */
export function writeChatReply(reply: ChatReply, write: (text: string) => void): void {
  write(reply.answer + '\n');
}
