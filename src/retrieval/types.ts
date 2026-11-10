export type RetrievalKind = 'FACT'|'PREFERENCE'|'SUMMARY';
export type RetrievalOrigin = 'STATEMENT'|'EXCERPT';
export interface RetrievalRecord {
  id:string;actorId:string;origin:RetrievalOrigin;kind:RetrievalKind|null;content:string;importance:number;
  documentId?:string|null;documentTitle?:string|null;sourceUri?:string|null;chunkIndex?:number|null;locator?:string|null;
  expiresAt?:Date|null;supersededAt?:Date|null;deletedAt?:Date|null;
}
export interface MemorySaveInput { actorId:string;kind:RetrievalKind;content:string;importance?:number;sourceTurnId?:string;expiresAt?:Date }
export interface MemorySupersedeInput { actorId:string;previousMemoryId:string;content:string;importance?:number;expiresAt?:Date }
export interface RetrievalInsert extends Omit<RetrievalRecord,'id'> { embedding:number[];sourceTurnId?:string }
export interface SearchHit extends RetrievalRecord { score:number }
export interface DocumentInput { actorId:string;documentId:string;text:string;documentTitle?:string;sourceUri?:string;locator?:string }
