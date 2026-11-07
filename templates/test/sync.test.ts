import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore script module
import { copyShared, listTemplates } from '../../scripts/sync-templates';

describe('sync-templates --dry-run copy', () => {
  it('copies _shared/* into every tpl-* dir and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
    mkdirSync(join(dir, '_shared')); mkdirSync(join(dir, 'tpl-a')); mkdirSync(join(dir, 'tpl-b')); mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, '_shared/render.js'), 'R'); writeFileSync(join(dir, '_shared/base.css'), 'B');
    expect(listTemplates(dir)).toEqual(['tpl-a', 'tpl-b']);
    const n = copyShared(dir);
    expect(n).toBe(4);
    for (const t of ['tpl-a', 'tpl-b']) {
      expect(readFileSync(join(dir, t, 'render.js'), 'utf8')).toBe('R');
      expect(readFileSync(join(dir, t, 'base.css'), 'utf8')).toBe('B');
    }
    expect(existsSync(join(dir, 'fixtures/render.js'))).toBe(false);
  });
});
