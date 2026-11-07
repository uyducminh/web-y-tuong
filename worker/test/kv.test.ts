import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getJson, putJson, incr } from '../src/kv';

describe('kv helpers', () => {
  it('putJson/getJson round trip; missing -> null', async () => {
    await putJson(env.KV, 'k1', { a: 1 });
    expect(await getJson(env.KV, 'k1')).toEqual({ a: 1 });
    expect(await getJson(env.KV, 'missing')).toBeNull();
  });
  it('incr counts up', async () => {
    expect(await incr(env.KV, 'c1', 120)).toBe(1);
    expect(await incr(env.KV, 'c1', 120)).toBe(2);
  });
});
