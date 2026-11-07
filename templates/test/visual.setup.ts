import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Copy _shared/* into each template before the visual tests (files are git-ignored).
export default function globalSetup() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  execFileSync(resolve(root, 'node_modules/.bin/tsx'), [resolve(root, 'scripts/sync-templates.ts'), '--dry-run'], { stdio: 'inherit', cwd: root });
}
