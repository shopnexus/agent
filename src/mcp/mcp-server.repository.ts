import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  status: string;
  toolCount: number | null;
  installedAt: Date;
  lastPing: Date | null;
}

@Injectable()
export class McpServerRepository {
  private readonly log = new Logger(McpServerRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(status = 'active'): Promise<McpServerRecord[]> {
    return this.prisma.mcpServer.findMany({
      where: { status },
      orderBy: { installedAt: 'asc' },
    });
  }

  async upsert(name: string, url: string, toolCount?: number): Promise<McpServerRecord> {
    return this.prisma.mcpServer.upsert({
      where: { name },
      update: {
        url,
        toolCount: toolCount ?? undefined,
        status: 'active',
        lastPing: new Date(),
      },
      create: {
        name,
        url,
        toolCount: toolCount ?? null,
      },
    });
  }

  async findByName(name: string): Promise<McpServerRecord | null> {
    return this.prisma.mcpServer.findUnique({
      where: { name },
    });
  }

  async disable(name: string): Promise<void> {
    await this.prisma.mcpServer.update({
      where: { name },
      data: { status: 'disabled' },
    });
  }

  async ping(name: string, toolCount: number): Promise<void> {
    await this.prisma.mcpServer.update({
      where: { name },
      data: {
        lastPing: new Date(),
        toolCount,
      },
    });
  }
}
