import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class ConversationRepository {
  constructor(private readonly prisma:PrismaService) {}
  create(actorId:string) { return this.prisma.conversation.create({data:{actorId}}); }
  listByActor(actorId:string,limit=50) {
    return this.prisma.conversation.findMany({where:{actorId,status:'active'},orderBy:[{lastActivityAt:'desc'},{id:'asc'}],take:limit,
      include:{_count:{select:{turns:true}}}});
  }
  findByIdForActor(id:string,actorId:string) { return this.prisma.conversation.findFirst({where:{id,actorId}}); }
}
