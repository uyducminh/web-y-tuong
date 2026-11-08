import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const toml = readFileSync(fileURLToPath(new URL('../worker/wrangler.toml', import.meta.url)), 'utf8');

describe('worker/wrangler.toml', () => {
  it('never sets ALLOW_TEST_SEED (the test-only KV seed route), in any env', () => {
    expect(toml).not.toMatch(/^\s*ALLOW_TEST_SEED\s*=/m);
  });
  it('declares PLATFORM_NAME and CONTACT_PHONE; no wrangler Text rules (templates are embedded by scripts/embed-templates.ts)', () => {
    expect(toml).toMatch(/^PLATFORM_NAME = "Web Làng"$/m);
    expect(toml).toMatch(/^CONTACT_PHONE = /m);
    expect(toml).not.toContain('[[rules]]');
  });
});
