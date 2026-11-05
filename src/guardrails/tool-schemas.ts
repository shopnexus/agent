import { z } from 'zod';

const PRODUCT_ID_RE = /^PROD-\d+$/i;
const ORDER_ID_RE = /^ORD-\d+$/i;

export const TOOL_SCHEMAS = {
  search_products: z.object({
    query: z.string().min(1).max(200).optional(),
    category: z.enum(['Thời trang', 'Điện tử', 'Giày dép', 'Gia dụng', 'Phụ kiện điện tử', 'Phụ kiện máy tính', 'Sách', 'Đồ chơi']).optional(),
    page: z.number().int().min(1).max(5).default(1),
    limit: z.number().int().min(1).max(10).default(10),
    minPrice: z.number().nonnegative().optional(),
    maxPrice: z.number().nonnegative().optional(),
  }).refine(d => d.query || d.category, { message: 'query or category required' }),

  get_product: z.object({
    productId: z.string().regex(PRODUCT_ID_RE, 'Invalid product_id format'),
  }),

  get_order: z.object({
    orderId: z.string().regex(ORDER_ID_RE, 'Invalid order_id format'),
  }),

  get_policy: z.object({
    question: z.string().min(1).max(500),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const ALLOWED_TOOLS: Set<string> = new Set(Object.keys(TOOL_SCHEMAS));

/** Max result sizes to enforce at gateway level */
export const TOOL_RESULT_CAPS: Record<ToolName, number> = {
  search_products: 10,   // max items
  get_product: 1,
  get_order: 1,
  get_policy: 1,
};
