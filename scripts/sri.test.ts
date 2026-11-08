// The CDN scripts are loaded with Subresource Integrity. The hashes are hard-coded in the page scripts; this test
// recomputes each one from the npm package in node_modules (jsDelivr /npm/ serves the npm tarball byte for byte; the two
// cdnjs files are the npm dist files) and checks the pinned version matches the installed one.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** `const <NAME>_URL = '…'` + `const <NAME>_SRI = '…'` pairs of a page script. */
function pinned(file: string): { name: string; url: string; sri: string }[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const consts = Object.fromEntries([...src.matchAll(/const ([A-Z0-9_]+) = '([^']+)';/g)].map((m) => [m[1], m[2]]));
  return Object.keys(consts).filter((k) => k.endsWith('_SRI')).map((k) => {
    const name = k.slice(0, -4);
    return { name, url: consts[`${name}_URL`]!, sri: consts[k]! };
  });
}

/** CDN URL → the npm file it serves, from `<pkgDir>/node_modules`. */
function npmFile(pkgDir: string, url: string): { path: string; version: string; installed: string } {
  const u = new URL(url);
  let name: string; let version: string; let rel: string[];
  if (u.host === 'cdn.jsdelivr.net') {
    const m = /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m) throw new Error(`unexpected jsDelivr path ${url}`);
    [, name, version] = m; rel = [m[3]];
  } else if (u.host === 'cdnjs.cloudflare.com') {
    const m = /^\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m) throw new Error(`unexpected cdnjs path ${url}`);
    [, name, version] = m; rel = [`dist/${m[3]}`, m[3]];
  } else throw new Error(`unknown CDN ${url}`);
  const dir = join(ROOT, pkgDir, 'node_modules', name);
  const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string;
  const path = rel.map((r) => join(dir, r)).find(existsSync);
  if (!path) throw new Error(`no npm file for ${url} in ${dir}`);
  return { path, version, installed };
}

const sha384 = (p: string) => `sha384-${createHash('sha384').update(readFileSync(p)).digest('base64')}`;

const PAGES: [file: string, pkgDir: string, names: string[]][] = [
  ['worker/src/static/package/package.js', 'worker', ['HTML2CANVAS', 'DOCX']],
  ['web-main/js/upload.js', 'web-main', ['MAMMOTH', 'SHEETJS']],
];

describe('SRI hashes of CDN scripts', () => {
  for (const [file, pkgDir, names] of PAGES) {
    it(`${file}: every pinned CDN script matches the installed npm file`, () => {
      const list = pinned(file);
      expect(list.map((x) => x.name).sort()).toEqual([...names].sort());
      for (const { url, sri } of list) {
        const f = npmFile(pkgDir, url);
        expect(f.installed, `${url}: installed version`).toBe(f.version);
        expect(sri, url).toBe(sha384(f.path));
      }
    });
  }

  it('the package page CSP script-src is only self + the pinned library folders', () => {
    const src = readFileSync(join(ROOT, 'worker/src/routes/package.ts'), 'utf8');
    const sources = /"script-src ([^"]+)"/.exec(src)![1]!.split(' ').filter((s) => s !== "'self'");
    const urls = pinned('worker/src/static/package/package.js').map((x) => x.url);
    expect(sources).toHaveLength(urls.length);
    for (const s of sources) {
      expect(s).toMatch(/^https:\/\/[^/]+\/.+\/$/); // a path (folder), never a bare host
      expect(urls.filter((u) => u.startsWith(s))).toHaveLength(1);
    }
  });
});
