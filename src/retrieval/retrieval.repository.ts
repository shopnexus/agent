import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { MemorySupersedeInput, RetrievalInsert, RetrievalRecord, RetrievalOrigin, SearchHit } from './types';
const columns=Prisma.sql`id, actor_id AS "actorId", origin, kind, importance, content,
  document_id AS "documentId",document_title AS "documentTitle",source_uri AS "sourceUri",chunk_index AS "chunkIndex",locator,
  superseded_at AS "supersededAt",deleted_at AS "deletedAt",expires_at AS "expiresAt"`;
@Injectable()
export class RetrievalRepository {
  constructor(private readonly prisma:PrismaService) {}
  insertMemory(params:RetrievalInsert):Promise<RetrievalRecord> { return this.insert(this.prisma,params); }
  async insertDocument(chunks:RetrievalInsert[]):Promise<RetrievalRecord[]> {
    return this.prisma.$transaction(async tx=>{
      // Reimport uses a new document ID; do not silently duplicate a document.
      const first=chunks[0];if(!first)return [];
      await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${first.actorId},hashtextextended(${first.documentId!},0)))) AS l`;
      const existing=await tx.retrieval.findFirst({where:{actorId:first.actorId,documentId:first.documentId}});
      if(existing)throw new Error('Document already imported; use a new document ID');
      const rows:RetrievalRecord[]=[];
      for(const chunk of chunks)rows.push(await this.insert(tx,chunk));
      return rows;
    },{timeout:30_000});
  }
  async findCurrentMemory(actorId:string,id:string):Promise<RetrievalRecord|null> {
    return this.prisma.retrieval.findFirst({where:{id,actorId,origin:'STATEMENT',supersededAt:null,deletedAt:null,OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}]}});
  }
  async supersedeMemory(params:MemorySupersedeInput & {embedding:number[]}):Promise<RetrievalRecord> {
    return this.prisma.$transaction(async tx=>{
      const rows=await tx.$queryRaw<RetrievalRecord[]>`SELECT ${columns} FROM retrieval WHERE id=${params.previousMemoryId}::uuid AND actor_id=${params.actorId}
        AND origin='STATEMENT' AND superseded_at IS NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE`;
      const previous=rows[0];if(!previous)throw new Error('Memory correction target is not current');
      const saved=await this.insert(tx,{actorId:params.actorId,origin:'STATEMENT',kind:previous.kind,content:params.content,embedding:params.embedding,
        importance:params.importance ?? previous.importance,expiresAt:params.expiresAt ?? previous.expiresAt});
      await tx.retrieval.update({where:{id:previous.id},data:{supersededAt:new Date(),supersededBy:saved.id}});
      return saved;
    });
  }
  private async insert(tx:Pick<Prisma.TransactionClient,'$queryRaw'>,p:RetrievalInsert):Promise<RetrievalRecord> {
    const rows=await tx.$queryRaw<RetrievalRecord[]>`INSERT INTO retrieval
      (actor_id,origin,kind,importance,content,search_text,embedding,source_turn_id,expires_at,document_id,document_title,source_uri,chunk_index,locator)
      VALUES (${p.actorId},${p.origin}::retrieval_origin,${p.kind}::retrieval_kind,${p.importance ?? 3},${p.content},${p.content.normalize('NFC').trim()},
        ${`[${p.embedding.join(',')}]`}::vector,${p.sourceTurnId ?? null}::uuid,${p.expiresAt ?? null},${p.documentId ?? null}::uuid,
        ${p.documentTitle ?? null},${p.sourceUri ?? null},${p.chunkIndex ?? null},${p.locator ?? null}) RETURNING ${columns}`;
    if(!rows[0])throw new Error('Retrieval insert returned no ID');return rows[0];
  }
  async searchMemories(p:{actorId:string;query:string;queryEmbedding:number[];limit:number;origin?:RetrievalOrigin}):Promise<SearchHit[]> {
    const vector=`[${p.queryEmbedding.join(',')}]`;
    // MATERIALIZED applies owner/lifecycle filters before ANN ranking, avoiding post-filter recall loss.
    const rows=await this.prisma.$queryRaw<SearchHit[]>`WITH active AS MATERIALIZED (
      SELECT * FROM retrieval WHERE actor_id=${p.actorId} AND superseded_at IS NULL AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at>NOW()) AND (${p.origin ?? null}::retrieval_origin IS NULL OR origin=${p.origin ?? null}::retrieval_origin)
    ), semantic AS (
      SELECT id,ROW_NUMBER() OVER (ORDER BY embedding <=> ${vector}::vector,id) AS rank FROM active
      WHERE 1-(embedding <=> ${vector}::vector) >= 0.25 ORDER BY embedding <=> ${vector}::vector,id LIMIT 40
    ), lexical AS (
      SELECT id,ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('simple',search_text),plainto_tsquery('simple',${p.query})) DESC,id) AS rank FROM active
      WHERE to_tsvector('simple',search_text) @@ plainto_tsquery('simple',${p.query})
      ORDER BY ts_rank_cd(to_tsvector('simple',search_text),plainto_tsquery('simple',${p.query})) DESC,id LIMIT 40
    ), literal AS (
      SELECT id,ROW_NUMBER() OVER (ORDER BY similarity(search_text,${p.query}) DESC,id) AS rank FROM active
      WHERE strpos(lower(search_text),lower(${p.query}))>0 OR similarity(search_text,${p.query})>0.2
      ORDER BY similarity(search_text,${p.query}) DESC,id LIMIT 40
    ), ranks AS (
      SELECT id,SUM(1.0/(60+rank)) AS score FROM (SELECT * FROM semantic UNION ALL SELECT * FROM lexical UNION ALL SELECT * FROM literal) candidates GROUP BY id
    ) SELECT a.id,a.actor_id AS "actorId",a.origin,a.kind,a.content,a.importance,a.document_id AS "documentId",a.document_title AS "documentTitle",
      a.source_uri AS "sourceUri",a.chunk_index AS "chunkIndex",a.locator,r.score
      FROM active a JOIN ranks r ON r.id=a.id ORDER BY r.score DESC,a.id LIMIT ${p.limit}`;
    return rows.map(row=>({...row,score:Number(row.score)}));
  }
}
