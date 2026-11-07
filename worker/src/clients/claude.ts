import type { ClaudeClient } from '../types';

type Opts = { apiKey: string | undefined; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };
const BACKOFF_MS = [500, 1500];

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
      let lastErr: unknown;
      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
        try {
          const res = await doFetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey ?? '', 'anthropic-version': '2023-06-01' },
            body,
          });
          if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
          const data = (await res.json()) as any;
          const block = (data.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === o.tool.name);
          if (!block) throw new Error('Claude returned no tool_use block');
          return {
            input: block.input as T,
            usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
          };
        } catch (e) { lastErr = e; }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Claude request failed');
    },
  };
}
