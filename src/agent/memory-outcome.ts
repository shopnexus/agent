export interface MemoryWriteEffect {
  toolUseId: string;
  operation: 'save' | 'supersede';
  status: 'pending' | 'completed' | 'uncertain';
}
