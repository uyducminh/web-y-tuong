import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, OUT_FILE, PACKAGE_DIR } from './embed-templates';

describe('embed-templates', () => {
  it('committed worker/src/static/templates.gen.ts matches templates/ and worker/src/static/package/ sources', () => {
    expect(readFileSync(OUT_FILE, 'utf8')).toBe(generate());
  });
  it('embeds every tpl-* and the shared files', () => {
    const out = generate();
    for (const t of ['tpl-ban-hang', 'tpl-thu-lead', 'tpl-gioi-thieu']) expect(out).toContain(`"${t}": { html:`);
    expect(out).toContain('renderJs:');
    expect(out).toContain('baseCss:');
  });
  it('embeds the package page files verbatim', () => {
    const out = generate();
    for (const [k, f] of [['html', 'package.html'], ['js', 'package.js'], ['css', 'package.css']]) {
      expect(out).toContain(`  ${k}: ${JSON.stringify(readFileSync(join(PACKAGE_DIR, f), 'utf8'))},`);
    }
  });
});
