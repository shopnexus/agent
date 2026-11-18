import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { answerInput, askUserInput, writeDocumentInput, type AnswerBlock, type ClarifyQuestion, type DocumentSection } from './answer-blocks';

/** What the output tools do to the run; the runner implements it. */
export interface OutputHost {
  beginStep(title: string): string;
  endStep(summary: string): string | undefined;
  /** Checks and records the answer; returns an error for the model, or nothing. */
  answer(blocks: AnswerBlock[]): Promise<string | undefined>;
  writeDocument(input: { title: string; document_id?: string; sections: DocumentSection[] }): Promise<{ document_id: string; version: number } | string>;
  askUser(questions: ClarifyQuestion[]): void;
}

export const OUTPUT_TOOLS: ReadonlySet<string> = new Set(['begin_step', 'end_step', 'answer', 'write_document', 'ask_user']);

/** The tools through which the model shapes the run: steps, the answer, documents and questions. */
export function outputTools(host: OutputHost) {
  return [
    tool({
      name: 'begin_step',
      description: 'Open a step of the work with a short title (for example "Read the ticket"). Tool calls until end_step belong to it.',
      inputSchema: z.object({ title: z.string().min(1).max(120) }),
      callback: ({ title }) => ({ step_id: host.beginStep(title) }),
    }),
    tool({
      name: 'end_step',
      description: 'Close the open step with a one-line summary of what it found.',
      inputSchema: z.object({ summary: z.string().min(1).max(300) }),
      callback: ({ summary }) => {
        const id = host.endStep(summary);
        if (!id) throw new Error('No step is open.');
        return { step_id: id };
      },
    }),
    tool({
      name: 'answer',
      description: 'Give the final answer as blocks. Call it once, last. Blocks: text {markdown} citing sources as [n]; ' +
        'figures {items: 2-4 of {value, label, change?, tone?}}; table {columns, rows} (at most 20 rows); ' +
        'chart {kind: bar|stacked_bar|line, labels, series: [{name, values}]}; document_ref {document_id, version}; follow_ups {items: up to 3}.',
      inputSchema: answerInput,
      callback: async ({ blocks }) => {
        const error = await host.answer(blocks as AnswerBlock[]);
        if (error) throw new Error(error);
        return 'Answer recorded. Stop here.';
      },
    }),
    tool({
      name: 'write_document',
      description: 'Save a longer result as a document of this chat (markdown, table and chart sections). Pass document_id to write a new version. ' +
        'Then add a document_ref block with the returned id and version to the answer.',
      inputSchema: writeDocumentInput,
      callback: async input => {
        const result = await host.writeDocument(input as { title: string; document_id?: string; sections: DocumentSection[] });
        if (typeof result === 'string') throw new Error(result);
        return result;
      },
    }),
    tool({
      name: 'ask_user',
      description: 'Ask the member clarifying questions with options when the question cannot be answered well without them. The run waits for the answers.',
      inputSchema: askUserInput,
      callback: ({ questions }) => {
        host.askUser(questions as ClarifyQuestion[]);
        return 'The member will answer. Stop here.';
      },
    }),
  ];
}
