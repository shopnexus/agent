import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { chromium, type Browser } from 'playwright-core';
import {
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { AgentCoreClient } from '../aws/agentcore-client';
import { signCdpHeaders } from './sigv4-cdp';
import { config } from '../config';

/**
 * AgentCore Browser — a managed cloud browser the agent drives over CDP with
 * Playwright (real, JS-rendered pages, unlike web_search / plain HTTP fetch).
 *
 * One browser session is started lazily and reused, then stopped on shutdown.
 * Exposed as the `browse` tool (navigate + extract rendered text).
 *
 * The CDP WebSocket handshake is SigV4-signed for bedrock-agentcore (see
 * sigv4-cdp.ts). Not yet validated against live AWS — if the connection is
 * rejected, that signing step is the thing to check first.
 */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  private readonly log = new Logger(BrowserService.name);
  private browser?: Browser;
  private sessionId?: string;
  private starting?: Promise<Browser>;

  constructor(private readonly aws: AgentCoreClient) {}

  /** Strands tool: open a URL in the cloud browser and return its rendered text. */
  asTool() {
    return tool({
      name: 'browse',
      description:
        'Open a URL in a real cloud browser (executes JavaScript) and return the ' +
        "page's rendered text. Use for dynamic/JS-heavy pages or when a plain " +
        'search snippet is not enough.',
      inputSchema: z.object({
        url: z.url().describe('The page URL to open.'),
        max_chars: z.number().int().min(500).max(50000).default(8000),
      }),
      callback: async (input) => this.browse(input.url, input.max_chars),
    });
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (!this.starting) {
      this.starting = this.startSession();
    }
    return this.starting;
  }

  private async startSession(): Promise<Browser> {
    const res = await this.aws.client.send(
      new StartBrowserSessionCommand({
        browserIdentifier: config.browser.browser_id,
        name: 'aws-agent-demo',
        sessionTimeoutSeconds: 3600,
      }),
    );
    const endpoint = res.streams?.automationStream?.streamEndpoint;
    if (!res.sessionId || !endpoint) {
      throw new Error('StartBrowserSession returned no session/automation endpoint');
    }
    this.sessionId = res.sessionId;
    // The CDP WebSocket upgrade must be SigV4-signed for bedrock-agentcore.
    const headers = await signCdpHeaders(endpoint, {
      region: this.aws.client.config.region,
      credentials: this.aws.client.config.credentials,
    });
    this.browser = await chromium.connectOverCDP(endpoint, { headers });
    this.log.log(`browser session started: ${res.sessionId}`);
    return this.browser;
  }

  private async browse(url: string, maxChars: number): Promise<string> {
    const browser = await this.ensureBrowser();
    // The managed browser exposes a default context/page; reuse it.
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    const text = await page.innerText('body').catch(() => '');
    const body = text.trim().replace(/\n{3,}/g, '\n\n');
    return `# ${title}\n${url}\n\n${body.slice(0, maxChars)}`;
  }

  async onModuleDestroy() {
    try {
      await this.browser?.close();
    } catch {
      /* best-effort */
    }
    if (!this.sessionId) return;
    try {
      await this.aws.client.send(
        new StopBrowserSessionCommand({
          browserIdentifier: config.browser.browser_id,
          sessionId: this.sessionId,
        }),
      );
    } catch {
      /* best-effort cleanup */
    }
  }
}
