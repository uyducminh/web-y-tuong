// Usage: tsx scripts/sync-templates.ts --dry-run
//        tsx scripts/sync-templates.ts <github-org>
// --dry-run copies templates/_shared/* into every templates/tpl-* dir (no network).
// With an org it also pushes each template dir to <org>/<tpl> and marks the repo as a template.
import { cpSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(HERE, '../templates');

export function listTemplates(dir = TEMPLATES_DIR): string[] {
  return readdirSync(dir)
    .filter((n) => n.startsWith('tpl-') && statSync(join(dir, n)).isDirectory())
    .sort();
}

/** Copies every file in <dir>/_shared into each tpl-* dir. Returns number of files copied. */
export function copyShared(dir = TEMPLATES_DIR): number {
  const shared = join(dir, '_shared');
  if (!existsSync(shared)) throw new Error(`missing ${shared}`);
  const files = readdirSync(shared).filter((f) => statSync(join(shared, f)).isFile());
  let n = 0;
  for (const t of listTemplates(dir)) {
    for (const f of files) { cpSync(join(shared, f), join(dir, t, f)); n++; }
  }
  return n;
}

function run(cmd: string, args: string[], cwd?: string) {
  return execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Pushes each template (with copied shared files) to <org>/<tpl> and sets is_template. Not tested offline. */
export function pushAll(org: string, dir = TEMPLATES_DIR) {
  for (const t of listTemplates(dir)) {
    const full = `${org}/${t}`;
    try { execFileSync('gh', ['repo', 'view', full], { stdio: 'ignore' }); }
    catch { run('gh', ['repo', 'create', full, '--public', '--description', `SME template ${t}`]); }
    const tmp = mkdtempSync(join(tmpdir(), 'tplpush-'));
    try {
      cpSync(join(dir, t), tmp, { recursive: true });
      run('git', ['init', '-q', '-b', 'main'], tmp);
      run('git', ['add', '-A'], tmp);
      run('git', ['-c', 'user.name=sme-bot', '-c', 'user.email=bot@example.com', 'commit', '-qm', 'sync template'], tmp);
      run('git', ['push', '-f', `https://github.com/${full}.git`, 'main'], tmp);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    run('gh', ['api', '-X', 'PATCH', `repos/${full}`, '-F', 'is_template=true']);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const n = copyShared();
  console.log(`copied ${n} shared files into ${listTemplates().length} templates`);
  if (!args.includes('--dry-run')) {
    const org = args.find((a) => !a.startsWith('--'));
    if (!org) { console.error('usage: sync-templates.ts [--dry-run] <org>'); process.exit(1); }
    pushAll(org);
  }
}
