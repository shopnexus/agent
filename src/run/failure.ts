import type { FailureCode } from './events';

/** The answer stored on a turn that did not succeed, shown in the conversation. */
export const FAILURE_ANSWERS: Record<FailureCode, string> = {
  agent_timeout: 'Quá thời gian trả lời. Hãy hỏi lại.',
  agent_budget: 'Hết hạn mức hôm nay.',
  agent_unavailable: 'Agent đang không trả lời được. Hãy thử lại sau.',
  agent_failed: 'Agent gặp lỗi giữa chừng. Có thể tiếp tục lượt này.',
  agent_limit: 'Lượt hỏi đã dùng hết số bước cho phép.',
  agent_context: 'Ngữ cảnh của lượt hỏi đã đầy.',
  agent_blocked: 'Lượt hỏi bị chặn.',
  agent_stuck: 'Lượt hỏi bị gián đoạn. Hãy hỏi lại.',
};
