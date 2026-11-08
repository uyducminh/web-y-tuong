import { describe, it, expect } from 'vitest';
import { randString, configFromEnv, publisherFromEnv } from '../src/deps';

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
  it('publisherFromEnv: stub without GitHub App secrets, real client with them', async () => {
    const stub = publisherFromEnv({} as any, configFromEnv({} as any));
    await expect(stub.status('x')).rejects.toThrow('not implemented');
    const env = { GH_APP_ID: '1', GH_APP_PRIVATE_KEY: 'not-a-key', GH_INSTALLATION_ID: '2', GH_ORG: 'o' } as any;
    const real = publisherFromEnv(env, configFromEnv(env));
    // fails while importing the bogus key, before any network call
    await expect(real.status('x')).rejects.not.toThrow('not implemented');
    const cf = { ...env, PUBLISHER: 'cloudflare' };
    await expect(publisherFromEnv(cf, configFromEnv(cf)).status('x')).rejects.toThrow('not implemented');
  });
});

describe('makeDeps without GitHub', () => {
  it('does not throw when every GH_* variable is unset (publisher is optional)', async () => {
    const { makeDeps } = await import('../src/deps');
    const d = makeDeps({ KV: {} as any } as any);
    expect(d.publisher).toBeTruthy();
    expect(d.config.ghOrg).toBe('');
  });
});

describe('demo config', () => {
  it('CONTACT_PHONE, PLATFORM_NAME (default "Web Làng"), ALLOW_TEST_SEED only when "1"', () => {
    const d = configFromEnv({} as any);
    expect(d.contactPhone).toBe('');
    expect(d.platformName).toBe('Web Làng');
    expect(d.allowTestSeed).toBe(false);
    const c = configFromEnv({ CONTACT_PHONE: '0912', PLATFORM_NAME: 'Làng X', ALLOW_TEST_SEED: '1' } as any);
    expect([c.contactPhone, c.platformName, c.allowTestSeed]).toEqual(['0912', 'Làng X', true]);
    expect(configFromEnv({ ALLOW_TEST_SEED: 'true' } as any).allowTestSeed).toBe(false);
  });
});
