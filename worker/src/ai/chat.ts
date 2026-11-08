import { stepState, type StepId } from '@sme/schema';
import type { Deps, Msg, Session } from '../types';
import { buildSystemPrompt, CHAT_TOOL, MAX_CHOICES } from './prompts';
import { recordUsage } from './cost';
import { ClaudeError } from '../clients/claude';

export type Choice = { value: string; label: string; hint?: string };
export type Choices = { kind: 'single' | 'multi'; options: Choice[] };
export type ChatReply = { reply: string; briefPatch: unknown; quickReplies: string[]; choices?: Choices; askedOptional?: StepId };

export const MAX_TEXT = 2000;
const HISTORY = 20;
export const CHAT_TIMEOUT_MS = 30_000;

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function sanitizeChoices(raw: unknown): Choices | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { kind, options } = raw as { kind?: unknown; options?: unknown };
  if ((kind !== 'single' && kind !== 'multi') || !Array.isArray(options)) return undefined;
  const out: Choice[] = [];
  for (const o of options) {
    if (out.length >= MAX_CHOICES) break;
    const value = str((o as any)?.value, 100), label = str((o as any)?.label, 100);
    if (!value || !label) continue;
    const hint = str((o as any)?.hint, 200);
    out.push(hint ? { value, label, hint } : { value, label });
  }
  return out.length ? { kind, options: out } : undefined;
}

/** Calls Claude; mutates nothing. Caller persists on success. */
export async function chatTurn(deps: Deps, s: Session, userText: string): Promise<ChatReply> {
  const text = userText.slice(0, MAX_TEXT);
  const turn = s.turns + 1;
  const st = stepState(s.brief);
  const system = buildSystemPrompt({ turn, step: st.step, missing: st.missing, docsText: s.docsText });
  let messages: Msg[] = [...s.messages, { role: 'user' as const, content: text }].slice(-HISTORY);
  while (messages.length > 1 && messages[0].role !== 'user') messages = messages.slice(1);
  const model = deps.config.chatModel;
  let out;
  try {
    out = await deps.claude.callTool<Record<string, unknown>>({ model, system, messages, tool: CHAT_TOOL, maxTokens: 1024, timeoutMs: CHAT_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof ClaudeError) await recordUsage(deps, model, e.usage); // billed even though unusable
    throw e;
  }
  const { input, usage } = out;
  await recordUsage(deps, model, usage); // never throws
  const asked = input.askedOptional;
  return {
    reply: typeof input.reply === 'string' ? input.reply : '',
    briefPatch: input.briefPatch ?? {},
    quickReplies: Array.isArray(input.quickReplies) ? input.quickReplies.filter((q): q is string => typeof q === 'string').slice(0, 4) : [],
    choices: sanitizeChoices(input.choices),
    askedOptional: asked === 'tham_khao' || asked === 'tai_lieu' ? asked : undefined,
  };
}
