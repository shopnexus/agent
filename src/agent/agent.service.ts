import { Injectable } from '@nestjs/common';
import { Agent, SlidingWindowConversationManager, type AgentResult } from '@strands-agents/sdk';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { McpService } from '../mcp/mcp.service';
import { installOutputCap, readOutputTool } from './output-cap';
import { webSearchEnabled, webSearchTool } from '../tools/web-search';
import { rememberFactTool } from '../memory/remember-fact';
import { config } from '../config';

/** Caller-supplied context that grounds the agent to the current user session. */
export interface AgentContext {
  /** 'buyer' | 'seller' — shapes tone and what the agent offers to do. */
  role?: 'buyer' | 'seller';
  /** Reply language. Defaults to Vietnamese. */
  locale?: 'vi' | 'en';
  /** ID of the listing the user is currently viewing, if any. */
  listingId?: string;
  /** Display title of that listing, used for grounding without a tool call. */
  listingTitle?: string;
  /** Which page the user is on, for focused assistance. */
  page?: 'product' | 'cart' | 'order' | 'home';
}

export interface ChatReply {
  actorId: string;
  sessionId: string;
  answer: string;
}

// `AgentResult` is exported, so import it by name. The constructor config type
// (`tools`) is NOT exported, so derive it from the public constructor signature.
type AgentTools = NonNullable<NonNullable<ConstructorParameters<typeof Agent>[0]>['tools']>;

/**
 * One chat turn:
 *   load durable facts (Memory) -> build the tool set (MCP / tools)
 *   -> run the Strands agent loop -> persist the turn (Memory).
 *
 * Memory is keyed by actor so facts span sessions.
 * The Strands Agent owns the tool-use loop.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly mcp: McpService,
  ) { }

  /** Stateless single turn (HTTP): fresh agent, wait for the final answer. */
  async chat(
    actorId: string,
    sessionId: string,
    userText: string,
    ctx: AgentContext = {},
  ): Promise<ChatReply> {
    const agent = await this.prepareAgent(actorId, sessionId, ctx);
    const result = await agent.invoke(userText, invokeOptions());
    const answer = finalText(result) || '(no response)';
    await this.memory.saveTurn(actorId, sessionId, userText, answer);
    return { actorId, sessionId, answer };
  }

  /**
   * Build a ready-to-use agent (tools + output cap + memory injection). Reuse
   * one instance across a CLI session to keep in-session conversation history;
   * HTTP callers build a fresh one per request.
   */
  async prepareAgent(actorId: string, sessionId = 'default', ctx: AgentContext = {}): Promise<Agent> {
    const role = ctx.role ?? 'buyer';
    // Memory manager gives both a `search_memory` tool (active recall) and
    // auto-injection of a relevant <memory> block each turn.
    const memory = this.memory.createManager(actorId, role);
    const tools: AgentTools = [
      readOutputTool(),
      this.mcp.installTool(),
      rememberFactTool(this.memory, actorId, sessionId, role),
      ...(webSearchEnabled() ? [webSearchTool()] : []),
      ...memory.getTools(),
      ...this.mcp.getTools(),
    ];
    const agent = new Agent({
      model: this.llm.getModel(),
      systemPrompt: buildSystemPrompt(ctx),
      tools,
      // Bound history growth: tool-heavy turns add many messages, so keep only
      // the most recent window (and trim old tool results within it).
      conversationManager: new SlidingWindowConversationManager({
        windowSize: config.agent.conversation_window,
        shouldTruncateResults: true,
      }),
    });
    // Bound any single tool result before it enters context.
    installOutputCap(agent, config.agent.tool_output_cap);
    // Wire injection (and extraction hooks) onto this agent instance.
    await memory.initAgent(agent);
    return agent;
  }

  /** Stream one turn on an existing agent (CLI): yield raw events, then persist. */
  async *streamTurn(
    agent: Agent,
    actorId: string,
    sessionId: string,
    userText: string,
  ) {
    let result: AgentResult | undefined;
    for await (const event of agent.stream(userText, invokeOptions())) {
      if (event.type === 'agentResultEvent') result = event.result;
      yield event;
    }
    const answer = (result && finalText(result)) || '(no response)';
    await this.memory.saveTurn(actorId, sessionId, userText, answer);
  }
}

/** Shared invoke/stream options (turn cap when configured). */
function invokeOptions() {
  const turns = config.agent.max_turns;
  return turns > 0 ? { limits: { turns } } : undefined;
}

/** Pull the final assistant text out of the agent result's last message. */
function finalText(result: AgentResult): string {
  const blocks = result.lastMessage?.content ?? [];
  return blocks
    .filter((b) => b.type === 'textBlock')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/**
 * ShopNexus system prompt — rebuilt each turn to keep the current timestamp
 * accurate. Scopes the agent to its e-commerce role and grounds it with
 * caller-supplied page context.
 *
 * Per-user facts (history, preferences) are NOT here; they arrive as a
 * separate <memory> block injected by MemoryManager before each model call.
 */
function buildSystemPrompt(ctx: AgentContext): string {
  const now = new Date();
  const locale = ctx.locale ?? 'vi';
  const isVi = locale === 'vi';
  const datetime = new Intl.DateTimeFormat(isVi ? 'vi-VN' : 'en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);

  // --- identity & grounding ---
  const identity = [
    isVi
      ? 'Bạn là trợ lý mua sắm của ShopNexus — một AI hỗ trợ người dùng tìm'
      + ' sản phẩm, tra cứu đơn hàng và nhận tư vấn trên nền tảng.'
      : 'You are the ShopNexus shopping assistant — an AI that helps users find'
      + ' products, check orders, and get advice on the platform.',
    '',
    isVi
      ? `Ngày giờ hiện tại: ${datetime} (ISO: ${now.toISOString()}).`
      : `Current date & time: ${datetime} (ISO: ${now.toISOString()}).`,
    isVi
      ? 'Dữ liệu huấn luyện của bạn có thể lỗi thời. Luôn tin vào kết quả từ'
      + ' tool và thời gian ở trên — không bao giờ đoán giá, tồn kho, hay'
      + ' thời gian giao hàng mà không gọi tool.'
      : 'Your training data may be outdated. Always trust tool results and the'
      + ' time above — never guess prices, stock, or shipping estimates.',
  ];

  // --- page / listing context (dynamic) ---
  const pageCtx: string[] = [];
  if (ctx.listingId && ctx.listingTitle) {
    pageCtx.push(
      '',
      isVi
        ? `Người dùng đang xem sản phẩm: "${ctx.listingTitle}" (ID: ${ctx.listingId}).`
        + ' Ưu tiên trả lời câu hỏi về sản phẩm này trước khi gợi ý thay thế.'
        : `The user is viewing: "${ctx.listingTitle}" (ID: ${ctx.listingId}).`
        + ' Answer questions about this product before suggesting alternatives.',
    );
  } else if (ctx.page === 'cart') {
    pageCtx.push(
      '',
      isVi
        ? 'Người dùng đang xem giỏ hàng. Tập trung hỗ trợ hoàn tất đơn mua.'
        : 'The user is reviewing their cart. Focus on helping them complete the purchase.',
    );
  } else if (ctx.page === 'order') {
    pageCtx.push(
      '',
      isVi
        ? 'Người dùng đang xem trang đơn hàng. Ưu tiên tra cứu trạng thái và tiến độ giao hàng.'
        : 'The user is on the order page. Prioritise order status and delivery progress.',
    );
  }

  // --- scope: what the agent can / cannot do ---
  const scope = [
    '',
    isVi ? 'Bạn có thể:' : 'You can:',
    isVi
      ? '- Tìm kiếm và gợi ý sản phẩm phù hợp qua tool'
      : '- Search and recommend products using tools',
    isVi
      ? '- Tra cứu trạng thái đơn hàng và thông tin tài khoản'
      : '- Retrieve order status and account information',
    isVi
      ? '- Gợi nhớ sở thích người dùng đã chia sẻ trước đó (qua search_memory)'
      : '- Recall preferences the user shared before (via search_memory)',
    isVi
      ? '- Ghi nhớ thông tin cá nhân, sở thích, kích cỡ quần áo/giày để cá nhân hoá'
        + ' trải nghiệm mua sắm cho các lần sau (qua remember_fact)'
      : '- Remember personal info, preferences, clothing/shoe sizes for future'
        + ' personalisation (via remember_fact)',
    isVi
      ? '- Tìm kiếm web cho thông tin chung về thương hiệu, sản phẩm ngoài nền tảng'
      : '- Search the web for general brand info or external product comparisons',
    '',
    isVi ? 'Bạn không thể:' : 'You cannot:',
    isVi
      ? '- Thay đổi đơn hàng, hoàn tiền hay chỉnh thông tin thanh toán'
      : '- Modify orders, issue refunds, or change payment details',
    isVi
      ? '  → Hướng dẫn người dùng liên hệ người bán hoặc bộ phận hỗ trợ'
      : '  → Direct the user to the seller or support team instead',
    isVi
      ? '- Truy cập dữ liệu của người dùng khác'
      : '- Access another user\'s data',
    isVi
      ? '- Bịa giá, tồn kho, thông số kỹ thuật — luôn dùng tool để xác minh'
      : '- Fabricate prices, stock levels, or specs — always use a tool to verify',
  ];

  // --- personalisation guidance ---
  const personalisation = [
    '',
    isVi
      ? 'Cá nhân hoá: Khi người dùng chia sẻ tên, sở thích thương hiệu, kích cỡ'
        + ' (size giày, quần áo), ngân sách, hoặc phản hồi về lần mua trước,'
        + ' hãy dùng remember_fact để ghi nhớ cho các phiên sau. Không lưu thông'
        + ' tin tạm (giá, tồn kho) — tool khác đã trả về rồi.'
      : 'Personalisation: When the user shares their name, brand preferences,'
        + ' sizes (shoe, clothing), budget range, or feedback on a past purchase,'
        + ' use remember_fact to persist it for future sessions. Do NOT save'
        + ' transient info (prices, stock) — other tools already return those.',
  ];

  // --- tool priority guidance ---
  const toolGuide = [
    '',
    isVi ? 'Thứ tự ưu tiên dùng tool:' : 'Tool priority:',
    isVi
      ? '1. Câu hỏi về sản phẩm → search_products / get_product trước'
      : '1. Product questions → search_products / get_product first',
    isVi
      ? '2. Câu hỏi về đơn hàng  → get_order trước'
      : '2. Order questions → get_order first',
    isVi
      ? '3. Thông tin user đã nhắc trước đây → search_memory trước'
      : '3. Things the user mentioned before → search_memory first',
    isVi
      ? '4. User chia sẻ sở thích/thông tin cá nhân → remember_fact ngay'
      : '4. User shares preferences/personal info → remember_fact immediately',
    isVi
      ? '5. Thông tin bên ngoài nền tảng → web_search sau cùng'
      : '5. Info outside the platform → web_search last',
    isVi
      ? '6. Không chắc và không có tool nào giải quyết được → nói thẳng là không biết'
      : '6. Unsure and no tool can settle it → say you do not know',
  ];

  return [...identity, ...pageCtx, ...scope, ...personalisation, ...toolGuide].join('\n');
}
