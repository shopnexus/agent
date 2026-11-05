import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Actor } from '@prisma/client';

export type { Actor };

@Injectable()
export class ActorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Ensure the user row exists and keep locale current. */
  async upsert(id: string, locale = 'vi'): Promise<Actor> {
    return this.prisma.actor.upsert({
      where: { id },
      update: { locale },
      create: { id, locale },
    });
  }

  async findById(id: string): Promise<Actor | null> {
    return this.prisma.actor.findUnique({
      where: { id },
    });
  }
}
