import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { AgentError } from '../http/agent-error';

export interface SkillVariable { name: string; label?: string; default?: string }
export interface SkillInput { name: string; slug: string; description: string; prompt: string; variables: SkillVariable[] }

/** Saved questions under `/` in the ask box, shared with every member. */
@Injectable()
export class SkillRepository {
  constructor(private readonly prisma: PrismaService) {}

  list() { return this.prisma.skill.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 }); }

  find(id: string) { return this.prisma.skill.findUnique({ where: { id } }); }

  async create(createdBy: string, input: SkillInput) {
    try {
      return await this.prisma.skill.create({ data: { createdBy, ...input, variables: input.variables as unknown as Prisma.InputJsonArray } });
    } catch (error) { throw this.conflict(error); }
  }

  async update(id: string, input: Partial<SkillInput>) {
    try {
      const { variables, ...rest } = input;
      return await this.prisma.skill.update({ where: { id }, data: { ...rest, ...(variables ? { variables: variables as unknown as Prisma.InputJsonArray } : {}) } });
    } catch (error) { throw this.conflict(error); }
  }

  async delete(id: string): Promise<boolean> {
    return (await this.prisma.skill.deleteMany({ where: { id } })).count === 1;
  }

  private conflict(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return AgentError.skillExists();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return AgentError.notFound();
    return error;
  }
}
