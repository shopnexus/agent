import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import type { Skill } from '@prisma/client';
import { z } from 'zod';
import { ConsoleMember, ConsoleMemberGuard, Member } from '../console/console-member';
import { SkillRepository, type SkillInput } from '../db/skill.repository';
import { AgentError } from '../http/agent-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const variable = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().max(80).optional(), default: z.string().max(500).optional() });
const fields = {
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().max(500),
  prompt: z.string().trim().min(1).max(8000),
  variables: z.array(variable).max(20),
};
const create = z.object({ ...fields, slug: fields.slug.optional(), description: fields.description.default(''), variables: fields.variables.default([]) }).strict();
const update = z.object(fields).partial().strict();

/** A slug from the name: lower-case ASCII words joined by hyphens. */
export function slugOf(name: string): string {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return slug || 'skill';
}

function view(s: Skill) {
  return { id: s.id, created_by: s.createdBy, name: s.name, slug: s.slug, description: s.description, prompt: s.prompt,
    variables: s.variables, updated_at: s.updatedAt.toISOString() };
}

/**
 * Saved questions under `/` in the ask box. Every skill is shared with every
 * member; any member creates one, its creator or an admin changes or deletes it.
 */
@Controller('skills')
@UseGuards(ConsoleMemberGuard)
export class SkillsController {
  constructor(private readonly skills: SkillRepository) {}

  @Get()
  async list() { return (await this.skills.list()).map(view); }

  @Get(':id')
  async get(@Param('id') id: string) { return view(await this.found(id)); }

  @Post()
  @HttpCode(201)
  async create(@Member() member: ConsoleMember, @Body() body: unknown) {
    const parsed = create.safeParse(body ?? {});
    if (!parsed.success) throw AgentError.badRequest();
    const input: SkillInput = { ...parsed.data, slug: parsed.data.slug ?? slugOf(parsed.data.name) };
    return view(await this.skills.create(member.id, input));
  }

  @Patch(':id')
  async update(@Member() member: ConsoleMember, @Param('id') id: string, @Body() body: unknown) {
    const skill = await this.found(id);
    if (skill.createdBy !== member.id && member.role !== 'admin') throw AgentError.forbidden();
    const parsed = update.safeParse(body ?? {});
    if (!parsed.success) throw AgentError.badRequest();
    return view(await this.skills.update(id, parsed.data));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Member() member: ConsoleMember, @Param('id') id: string) {
    const skill = await this.found(id);
    if (skill.createdBy !== member.id && member.role !== 'admin') throw AgentError.forbidden();
    await this.skills.delete(id);
  }

  private async found(id: string) {
    if (!UUID.test(id)) throw AgentError.notFound();
    const skill = await this.skills.find(id);
    if (!skill) throw AgentError.notFound();
    return skill;
  }
}
