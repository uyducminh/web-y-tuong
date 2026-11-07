import { BriefSchema, briefProgress, type Brief } from '@sme/schema';
import type { Deps, Msg, Session } from '../types';
import { buildSystemPrompt, CHAT_TOOL } from './prompts';
import { addCost, costMicroUsd } from './cost';

export type ChatReply = { reply: string; briefPatch: Partial<Brief>; quickReplies: string[]; readyToGenerate: boolean };

export const MAX_TEXT = 2000;
const HISTORY = 20;

/** Shallow merge; lien_he merged one level deeper. Invalid patch keys are dropped. */
export function mergeBrief(brief: Brief, patch: unknown): Brief {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return brief;
  let cur = brief;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === 'meta' || v === undefined || v === null) continue;
    const next: any = { ...cur };
    next[k] = k === 'lien_he' && v && typeof v === 'object' ? { ...(cur.lien_he ?? {}), ...(v as object) } : v;
    const parsed = BriefSchema.safeParse(next);
    // zod strips unknown keys, so check the key actually survived
    if (parsed.success && (parsed.data as any)[k] !== undefined) cur = parsed.data;
  }
  return cur;
}

/** Calls Claude; mutates nothing. Caller persists on success. */
export async function chatTurn(deps: Deps, s: Session, userText: string): Promise<ChatReply> {
  const text = userText.slice(0, MAX_TEXT);
  const turn = s.turns + 1;
  const system = buildSystemPrompt({ turn, missing: briefProgress(s.brief).missing, docsText: s.docsText });
  let messages: Msg[] = [...s.messages, { role: 'user' as const, content: text }].slice(-HISTORY);
  while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1);
  const model = deps.config.chatModel;
  const { input, usage } = await deps.claude.callTool<ChatReply>({
    model, system, messages, tool: CHAT_TOOL, maxTokens: 1024,
  });
  await addCost(deps, costMicroUsd(model, usage, deps.config));
  return {
    reply: typeof input.reply === 'string' ? input.reply : '',
    briefPatch: (input.briefPatch ?? {}) as Partial<Brief>,
    quickReplies: Array.isArray(input.quickReplies) ? input.quickReplies.filter((q) => typeof q === 'string').slice(0, 4) : [],
    readyToGenerate: input.readyToGenerate === true,
  };
}
