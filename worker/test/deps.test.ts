import { describe, it, expect } from 'vitest';
import { randString, configFromEnv } from '../src/deps';

describe('deps', () => {
  it('rand(32) returns 32 chars of [a-z0-9], varying', () => {
    const a = randString(32), b = randString(32);
    expect(a).toMatch(/^[a-z0-9]{32}$/);
    expect(a).not.toBe(b);
  });
  it('configFromEnv: defaults and explicit DAILY_CAP_USD=0', () => {
    const c = configFromEnv({} as any);
    expect(c.chatModel).toBe('claude-haiku-5-5');
    expect(c.genModel).toBe('claude-sonnet-5-5');
    expect(c.dailyCapUsd).toBe(10);
    expect(configFromEnv({ DAILY_CAP_USD: '0' } as any).dailyCapUsd).toBe(0);
  });
});
