import { Injectable } from '@nestjs/common';
import { RetrievalRepository } from './retrieval.repository';
import { EmbeddingService } from '../llm/embedding.service';
import { DocumentInput, MemorySaveInput, MemorySupersedeInput, RetrievalOrigin, RetrievalInsert } from './types';
import { config } from '../config';
import { scanAndMaskPii } from '../guardrails/pii-utils';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_RE=/\b(?:password|passwd|otp|pin|token|api[\s_-]?key|cvv|cvc|cccd|cmnd|credit\s*card|debit\s*card|bank\s*account|mật khẩu|mã otp|số thẻ)\b/i;
@Injectable()
export class RetrievalService {
  constructor(private readonly repo:RetrievalRepository,private readonly embedding:EmbeddingService) {}
  async saveMemory(params:MemorySaveInput) {
    this.assertActor(params.actorId);
    const content=params.content.normalize('NFC').trim();
    this.assertEligible(content);this.assertOptions(params);
    if (!['FACT','PREFERENCE','SUMMARY'].includes(params.kind)) throw new Error('Invalid memory kind');
    return this.repo.insertMemory({...params,importance:params.importance ?? 3,content,origin:'STATEMENT',embedding:await this.createEmbedding(content)});
  }
  async supersedeMemory(params:MemorySupersedeInput) {
    this.assertActor(params.actorId);
    if (!UUID.test(params.previousMemoryId)) throw new Error('Invalid correction ID');
    const target=await this.repo.findCurrentMemory(params.actorId,params.previousMemoryId);
    if (!target || target.id!==params.previousMemoryId || target.actorId!==params.actorId || target.origin!=='STATEMENT' || target.deletedAt || target.supersededAt || (target.expiresAt && target.expiresAt.getTime()<=Date.now())) throw new Error('Memory correction target is not current');
    const content=params.content.normalize('NFC').trim();
    this.assertEligible(content);this.assertOptions(params);
    return this.repo.supersedeMemory({...params,content,embedding:await this.createEmbedding(content)});
  }
  async searchMemory(actorId:string,query:string,limit=config.memory.max_entries,origin?:RetrievalOrigin) {
    this.assertActor(actorId);
    if (origin!==undefined && !['STATEMENT','EXCERPT'].includes(origin)) throw new Error('Invalid retrieval origin');
    const normalized=query.normalize('NFC').trim();
    if (!normalized) return [];
    if (normalized.length>500 || !Number.isInteger(limit) || limit<1 || limit>20) throw new Error('Invalid retrieval query');
    const hits=await this.repo.searchMemories({actorId,query:normalized,queryEmbedding:await this.createEmbedding(normalized),limit,origin});
    let remaining=config.retrieval.context_chars;
    return hits.flatMap(hit=>{ if (remaining<100) return []; const content=hit.content.slice(0,remaining);remaining-=content.length;return [{...hit,content}]; });
  }
  /** Text ingestion only. All chunks embed successfully before the atomic write. */
  async ingestDocument(params:DocumentInput) {
    this.assertActor(params.actorId);
    if (!UUID.test(params.documentId) || !params.text.trim() || params.text.length>1_000_000) throw new Error('Invalid document');
    const text=params.text.normalize('NFC').trim();
    const chunks:RetrievalInsert[]=[];
    for(let offset=0;offset<text.length;offset+=config.retrieval.chunk_chars) {
      const content=text.slice(offset,offset+config.retrieval.chunk_chars).trim();
      if (!content) continue;
      chunks.push({actorId:params.actorId,origin:'EXCERPT',kind:null,content,importance:3,embedding:await this.createEmbedding(content),
        documentId:params.documentId,documentTitle:params.documentTitle,sourceUri:params.sourceUri,locator:params.locator,chunkIndex:chunks.length});
    }
    return this.repo.insertDocument(chunks);
  }
  private assertActor(actorId:string) {if(!actorId.trim() || actorId.length>64)throw new Error('Invalid actor');}
  private assertOptions(params:{importance?:number;expiresAt?:Date}) {
    if(params.importance!==undefined && (!Number.isInteger(params.importance)||params.importance<1||params.importance>5))throw new Error('Memory importance is invalid');
    if(params.expiresAt && (!Number.isFinite(params.expiresAt.getTime())||params.expiresAt.getTime()<=Date.now()))throw new Error('Memory expiry must be a valid future timestamp');
  }
  private async createEmbedding(text:string) {
    const vector=await this.embedding.embed(text);
    if(vector.length!==1024 || vector.some(v=>!Number.isFinite(v)) || !vector.some(v=>v!==0))throw new Error('Embedding must be a finite nonzero 1024-dimensional vector');
    return vector;
  }
  private assertEligible(content:string) {
    if(content.length<3 || content.length>config.memory.entry_cap)throw new Error('Memory fact length is invalid');
    if(SECRET_RE.test(content)||scanAndMaskPii(content).hasPii)throw new Error('Sensitive memory is not allowed');
    if(/(?:price|stock|inventory|order status|tracking|giá|tồn kho|đơn hàng|vận chuyển)/i.test(content))throw new Error('Transient business data cannot be stored as user memory');
  }
}
