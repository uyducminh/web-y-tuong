import type { ClaudeClient } from '../types';

type Opts = { apiKey: string | undefined; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };
type Usage = { input_tokens: number; output_tokens: number };
const BACKOFF_MS = [500, 1500];
export const DEFAULT_TIMEOUT_MS = 60_000;

/** A Claude failure. `usage` is set when Anthropic billed the request (e.g. a reply without tool_use) so callers can record cost. */
export class ClaudeError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly usage?: Usage) {
    super(message); this.name = 'ClaudeError';
  }
}

/** Only network errors, 429 and 5xx (incl. 529 overloaded) are retried; other 4xx are permanent; a timeout is not retried (it may have been billed). */
const retryableStatus = (s: number) => s === 429 || s >= 500;

function usageOf(data: any): Usage | undefined {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return undefined;
  return { input_tokens: Number(u.input_tokens) || 0, output_tokens: Number(u.output_tokens) || 0 };
}

export function makeClaudeClient(opts: Opts): ClaudeClient {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async callTool<T>(o: Parameters<ClaudeClient['callTool']>[0]) {
      const body = JSON.stringify({
        model: o.model, max_tokens: o.maxTokens, system: o.system, messages: o.messages,
        tools: [{ name: o.tool.name, description: 'Trả về kết quả có cấu trúc.', input_schema: o.tool.input_schema }],
        tool_choice: { type: 'tool', name: o.tool.name },
      });
      // One deadline for the whole call, retries included.
      const deadline = Date.now() + (o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let lastErr: unknown;
      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        if (attempt > 0) {
          if (Date.now() + BACKOFF_MS[attempt - 1] >= deadline) break;
          await sleep(BACKOFF_MS[attempt - 1]);
        }
        let res: Response;
        try {
          res = await doFetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey ?? '', 'anthropic-version': '2023-06-01' },
            body, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        } catch (e) {
          const name = (e as Error)?.name;
          if (name === 'TimeoutError' || name === 'AbortError') throw new ClaudeError('Claude request timed out', false);
          lastErr = new ClaudeError(`Claude network error: ${(e as Error)?.message ?? e}`, true);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          lastErr = new ClaudeError(`Claude HTTP ${res.status}`, retryableStatus(res.status));
          if (retryableStatus(res.status)) continue;
          throw lastErr;
        }
        const data = (await res.json().catch(() => null)) as any;
        const usage = usageOf(data);
        const block = (data?.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === o.tool.name);
        if (!block) throw new ClaudeError('Claude returned no tool_use block', false, usage);
        return { input: block.input as T, usage: usage ?? { input_tokens: 0, output_tokens: 0 } };
      }
      throw lastErr instanceof Error ? lastErr : new ClaudeError('Claude request failed', true);
    },
  };
}
