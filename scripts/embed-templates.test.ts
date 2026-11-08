import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generate, OUT_FILE } from './embed-templates';

describe('embed-templates', () => {
  it('committed worker/src/static/templates.gen.ts matches templates/ sources', () => {
    expect(readFileSync(OUT_FILE, 'utf8')).toBe(generate());
  });
  it('embeds every tpl-* and the shared files', () => {
    const out = generate();
    for (const t of ['tpl-ban-hang', 'tpl-thu-lead', 'tpl-gioi-thieu']) expect(out).toContain(`"${t}": { html:`);
    expect(out).toContain('renderJs:');
    expect(out).toContain('baseCss:');
  });
});
