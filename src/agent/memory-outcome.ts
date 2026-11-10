import type { SupportLocale } from '../guardrails/support-policy';

export interface MemoryWriteEffect {
  toolUseId: string;
  operation: 'save' | 'supersede';
  status: 'pending' | 'completed' | 'uncertain';
}

/** Trusted status only: never copy personal content, tool output or draft text. */
export function memoryOutcomeNote(effects: readonly MemoryWriteEffect[], locale: SupportLocale): string {
  const notes: string[] = [];
  if (effects.some(effect => effect.operation === 'save' && effect.status === 'completed')) notes.push(locale === 'en'
    ? 'Personal information was saved during this turn.'
    : 'Thông tin cá nhân đã được lưu trong lượt này.');
  if (effects.some(effect => effect.operation === 'supersede' && effect.status === 'completed')) notes.push(locale === 'en'
    ? 'Personal information was corrected during this turn.'
    : 'Thông tin cá nhân đã được cập nhật trong lượt này.');
  if (effects.some(effect => effect.status !== 'completed')) notes.push(locale === 'en'
    ? 'A memory write may still be processing or may already have completed. Ask to check the remembered information before retrying the write.'
    : 'Yêu cầu ghi nhớ có thể vẫn đang được xử lý hoặc đã được thực hiện. Hãy yêu cầu kiểm tra thông tin đã nhớ trước khi thử ghi lại.');
  return notes.join(' ');
}
