import { z } from 'zod';

const cell = z.union([z.string().max(500), z.number(), z.null()]);

export const textBlock = z.object({
  type: z.literal('text'),
  markdown: z.string().min(1).max(20000).describe('Markdown; cite sources as [n] with the numbers from tool results.'),
});
export const figuresBlock = z.object({
  type: z.literal('figures'),
  items: z.array(z.object({
    value: z.union([z.string().max(40), z.number()]),
    label: z.string().min(1).max(80),
    change: z.string().max(40).optional(),
    tone: z.enum(['positive', 'negative', 'neutral', 'warning']).optional(),
  })).min(2).max(4).describe('Two to four key figures.'),
});
export const tableBlock = z.object({
  type: z.literal('table'),
  columns: z.array(z.string().min(1).max(80)).min(1).max(12),
  rows: z.array(z.array(cell)).max(20).describe('At most 20 rows; put longer tables in a document.'),
});
export const chartBlock = z.object({
  type: z.literal('chart'),
  kind: z.enum(['bar', 'stacked_bar', 'line']),
  labels: z.array(z.string().max(60)).min(1).max(60),
  series: z.array(z.object({ name: z.string().min(1).max(60), values: z.array(z.number()) })).min(1).max(8),
});
export const documentRefBlock = z.object({
  type: z.literal('document_ref'),
  document_id: z.string().uuid(),
  version: z.number().int().min(1),
});
export const followUpsBlock = z.object({
  type: z.literal('follow_ups'),
  items: z.array(z.string().min(1).max(200)).min(1).max(3).describe('Up to three follow-up questions the member may ask next.'),
});

export const answerBlock = z.discriminatedUnion('type', [textBlock, figuresBlock, tableBlock, chartBlock, documentRefBlock, followUpsBlock]);
export type AnswerBlock = z.infer<typeof answerBlock>;

/** Shape checks a JSON schema cannot say: row widths and series lengths. */
export const answerInput = z.object({ blocks: z.array(answerBlock).min(1).max(20) }).superRefine((input, ctx) => {
  input.blocks.forEach((block, i) => {
    if (block.type === 'table') {
      block.rows.forEach((row, r) => {
        if (row.length !== block.columns.length) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'rows', r], message: `row has ${row.length} cells, the table has ${block.columns.length} columns` });
      });
    }
    if (block.type === 'chart') {
      block.series.forEach((s, j) => {
        if (s.values.length !== block.labels.length) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'series', j], message: `series "${s.name}" has ${s.values.length} values for ${block.labels.length} labels` });
      });
    }
  });
});

/** A document section: markdown, a table or a chart. */
export const documentSection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('markdown'), markdown: z.string().min(1).max(50000) }),
  z.object({ kind: z.literal('table'), columns: z.array(z.string().min(1).max(80)).min(1).max(20), rows: z.array(z.array(cell)).max(500) }),
  z.object({ kind: z.literal('chart'), chart_kind: z.enum(['bar', 'stacked_bar', 'line']), labels: z.array(z.string().max(60)).min(1).max(100),
    series: z.array(z.object({ name: z.string().min(1).max(60), values: z.array(z.number()) })).min(1).max(8) }),
]);
export type DocumentSection = z.infer<typeof documentSection>;

export const writeDocumentInput = z.object({
  title: z.string().min(1).max(200),
  document_id: z.string().uuid().optional().describe('An existing document of this chat to write a new version of.'),
  sections: z.array(documentSection).min(1).max(50),
});

export const clarifyQuestion = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  label: z.string().min(1).max(200),
  kind: z.enum(['single', 'multi']),
  options: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/i), label: z.string().min(1).max(120), hint: z.string().max(200).optional() })).min(2).max(8),
  default: z.union([z.string(), z.array(z.string())]).optional(),
});
export type ClarifyQuestion = z.infer<typeof clarifyQuestion>;
export const askUserInput = z.object({ questions: z.array(clarifyQuestion).min(1).max(5) });
