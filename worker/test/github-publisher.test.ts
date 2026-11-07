import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeGithubClient, signAppJwt, _resetTokenCache, type FetchLike } from '../src/clients/github';
import { makeGithubPublisher } from '../src/publisher/github-publisher';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const b64urlDecode = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

let pem = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n');
  pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
});

type Call = { method: string; path: string; body: any; auth: string | null; headers: Headers };
type Handler = (c: Call, n: number) => { status: number; body?: unknown } | undefined;

const TEMPLATE_HTML = '<!doctype html>\n<html lang="vi">\n<head>\n  <meta name="lead-endpoint" content="">\n  <title>Đang tải...</title>\n</head></html>\n';

function fakeGithub(extra: Handler = () => undefined) {
  const calls: Call[] = [];
  let blobN = 0;
  const counts = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const c: Call = { method, path: u.pathname, body, auth: headers.get('authorization'), headers };
    calls.push(c);
    const key = `${method} ${u.pathname}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const res = extra(c, n) ?? route(c);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status });
  };
  function route(c: Call): { status: number; body?: unknown } {
    const k = `${c.method} ${c.path}`;
    if (k === 'POST /app/installations/77/access_tokens') return { status: 201, body: { token: 'ghs_tok', expires_at: '2099-01-01T00:00:00Z' } };
    if (/^POST \/repos\/Demo-Org\/tpl-[a-z-]+\/generate$/.test(k)) return { status: 201, body: { name: c.body.name } };
    if (/^GET \/repos\/Demo-Org\/tpl-[a-z-]+\/contents\/index\.html$/.test(k)) return { status: 200, body: { encoding: 'base64', content: b64(TEMPLATE_HTML).replace(/(.{60})/g, '$1\n') } };
    if (/\/git\/ref\/heads\/main$/.test(c.path) && c.method === 'GET') return { status: 200, body: { object: { sha: 'headsha' } } };
    if (/\/git\/commits\/headsha$/.test(c.path)) return { status: 200, body: { sha: 'headsha', tree: { sha: 'basetree' } } };
    if (/\/git\/blobs$/.test(c.path)) return { status: 201, body: { sha: `blob${++blobN}` } };
    if (/\/git\/trees$/.test(c.path)) return { status: 201, body: { sha: 'newtree' } };
    if (/\/git\/commits$/.test(c.path)) return { status: 201, body: { sha: 'newcommit' } };
    if (/\/git\/refs\/heads\/main$/.test(c.path) && c.method === 'PATCH') return { status: 200, body: {} };
    if (/\/pages$/.test(c.path) && c.method === 'POST') return { status: 201, body: {} };
    if (/\/pages$/.test(c.path) && c.method === 'GET') return { status: 404, body: { message: 'Not Found' } };
    return { status: 418, body: { message: `unrouted ${k}` } };
  }
  return { fetch, calls };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

function setup(extra?: Handler) {
  const fk = fakeGithub(extra);
  const gh = makeGithubClient({ appId: '123', privateKey: pem, installationId: '77', fetch: fk.fetch, sleep, nowMs: () => Date.parse('2026-11-08T05:00:00Z') });
  const pub = makeGithubPublisher({ gh, org: 'Demo-Org', leadEndpoint: 'https://api.test', sleep });
  return { ...fk, pub };
}

const files = [
  { path: 'site.json', base64: b64('{"a":1}') },
  { path: 'assets/1-a.jpg', base64: 'AAAA' },
  { path: 'assets/2-b.png', base64: 'BBBB' },
];

beforeEach(() => { _resetTokenCache(); sleeps.length = 0; });

describe('signAppJwt', () => {
  it('signs RS256 with iat=now-60, exp=now+540, iss=appId; accepts literal \\n escapes', async () => {
    const jwt = await signAppJwt('123', pem.replace(/\n/g, '\\n'), 1_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(b64urlDecode(h))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(b64urlDecode(p))).toEqual({ iat: 999_940, exp: 1_000_540, iss: '123' });
    const sig = Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});

describe('github client', () => {
  it('caches the installation token and sends standard headers', async () => {
    const { calls, pub } = setup();
    await pub.status('demo-x-abcd').catch(() => {});
    await pub.status('demo-x-abcd').catch(() => {});
    const tokenCalls = calls.filter((c) => c.path.endsWith('/access_tokens'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const api = calls.filter((c) => !c.path.endsWith('/access_tokens'));
    expect(api).toHaveLength(2);
    for (const c of api) {
      expect(c.auth).toBe('Bearer ghs_tok');
      expect(c.headers.get('accept')).toBe('application/vnd.github+json');
      expect(c.headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(c.headers.get('user-agent')).toBe('sme-mvp-builder');
    }
  });

  it('refreshes the token within 60s of expiry', async () => {
    let t = Date.parse('2026-11-08T05:00:00Z');
    const fk = fakeGithub((c, n) => c.path.endsWith('/access_tokens')
      ? { status: 201, body: { token: `tok${n}`, expires_at: new Date(t + 120_000).toISOString() } } : undefined);
    const gh = makeGithubClient({ appId: '1', privateKey: pem, installationId: '77', fetch: fk.fetch, sleep, nowMs: () => t });
    await gh.request('GET', '/x').catch(() => {});
    t += 30_000; await gh.request('GET', '/x').catch(() => {});
    t += 40_000; await gh.request('GET', '/x').catch(() => {});
    const auths = fk.calls.filter((c) => c.path === '/x').map((c) => c.auth);
    expect(auths).toEqual(['Bearer tok1', 'Bearer tok1', 'Bearer tok2']);
  });

  it('retries 5xx up to 3 times then throws', async () => {
    const fk = fakeGithub((c) => c.path === '/boom' ? { status: 502, body: {} } : undefined);
    const gh = makeGithubClient({ appId: '1', privateKey: pem, installationId: '77', fetch: fk.fetch, sleep });
    await expect(gh.request('GET', '/boom')).rejects.toMatchObject({ status: 502 });
    expect(fk.calls.filter((c) => c.path === '/boom')).toHaveLength(4);
  });
});

describe('GithubPublisher.create', () => {
  it('sends generate, blobs, tree, commit, ref, pages in order', async () => {
    const { calls, pub } = setup();
    const r = await pub.create({ repoName: 'demo-htx-abcd', template: 'tpl-thu-lead', files });
    expect(r).toEqual({ repo: 'demo-htx-abcd' });
    const seq = calls.filter((c) => !c.path.endsWith('/access_tokens')).map((c) => `${c.method} ${c.path}`);
    const R = '/repos/Demo-Org/demo-htx-abcd';
    expect(seq).toEqual([
      'POST /repos/Demo-Org/tpl-thu-lead/generate',
      'GET /repos/Demo-Org/tpl-thu-lead/contents/index.html',
      `GET ${R}/git/ref/heads/main`,
      `GET ${R}/git/commits/headsha`,
      `POST ${R}/git/blobs`, `POST ${R}/git/blobs`, `POST ${R}/git/blobs`, `POST ${R}/git/blobs`,
      `POST ${R}/git/trees`,
      `POST ${R}/git/commits`,
      `PATCH ${R}/git/refs/heads/main`,
      `POST ${R}/pages`,
    ]);
    const gen = calls.find((c) => c.path.endsWith('/generate'))!;
    expect(gen.body).toEqual({ owner: 'Demo-Org', name: 'demo-htx-abcd', private: false });
    const pages = calls.find((c) => c.path.endsWith('/pages'))!;
    expect(pages.body).toEqual({ source: { branch: 'main', path: '/' } });
  });

  it('puts every file plus the patched index.html into exactly one commit', async () => {
    const { calls, pub } = setup();
    await pub.create({ repoName: 'demo-htx-abcd', template: 'tpl-thu-lead', files });
    const blobs = calls.filter((c) => c.path.endsWith('/git/blobs'));
    expect(blobs.every((b) => b.body.encoding === 'base64')).toBe(true);
    const trees = calls.filter((c) => c.path.endsWith('/git/trees'));
    expect(trees).toHaveLength(1);
    expect(trees[0].body.base_tree).toBe('basetree');
    const tree = trees[0].body.tree as any[];
    expect(tree.map((x) => x.path).sort()).toEqual(['assets/1-a.jpg', 'assets/2-b.png', 'index.html', 'site.json']);
    expect(tree.every((x) => x.mode === '100644' && x.type === 'blob' && /^blob\d$/.test(x.sha))).toBe(true);
    const idx = tree.find((x) => x.path === 'index.html');
    const idxBlob = blobs[Number(idx.sha.slice(4)) - 1];
    const html = unb64(idxBlob.body.content);
    expect(html).toContain('<meta name="lead-endpoint" content="https://api.test">');
    expect(html).toContain('Đang tải...');
    const commits = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/commits'));
    expect(commits).toHaveLength(1);
    expect(commits[0].body).toMatchObject({ tree: 'newtree', parents: ['headsha'] });
    const refs = calls.filter((c) => c.method === 'PATCH');
    expect(refs).toHaveLength(1);
    expect(refs[0].body).toMatchObject({ sha: 'newcommit' });
  });

  it('(d) treats 422 on /generate (repo already exists, resumed publish) as existing and completes', async () => {
    const { calls, pub } = setup((c) => c.path.endsWith('/generate') ? { status: 422, body: { message: 'Name already exists on this account' } }
      : c.path.endsWith('/pages') && c.method === 'POST' ? { status: 409, body: { message: 'already enabled' } } : undefined);
    await expect(pub.create({ repoName: 'demo-htx-abcd', template: 'tpl-thu-lead', files })).resolves.toEqual({ repo: 'demo-htx-abcd' });
    expect(calls.filter((c) => c.path.endsWith('/generate'))).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(calls.filter((c) => c.path.endsWith('/pages'))).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('retries when a blob first returns 404 (repo not ready yet)', async () => {
    const { calls, pub } = setup((c, n) => c.path.endsWith('/git/blobs') && n === 1 ? { status: 404, body: { message: 'Not Found' } } : undefined);
    await pub.create({ repoName: 'demo-htx-abcd', template: 'tpl-thu-lead', files });
    expect(calls.filter((c) => c.path.endsWith('/git/blobs'))).toHaveLength(5);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(sleeps).toContain(2000);
  });

  it('retries 409 on ref lookup (empty repo) and gives up after 5 retries', async () => {
    const { calls, pub } = setup((c) => c.path.endsWith('/git/ref/heads/main') ? { status: 409, body: { message: 'Git Repository is empty.' } } : undefined);
    await expect(pub.create({ repoName: 'demo-htx-abcd', template: 'tpl-thu-lead', files })).rejects.toMatchObject({ status: 409 });
    expect(calls.filter((c) => c.path.endsWith('/git/ref/heads/main'))).toHaveLength(6);
    expect(sleeps.filter((s) => s === 2000)).toHaveLength(5);
  });
});

describe('GithubPublisher.update/status/remove', () => {
  it('update commits files in one commit without touching index.html or pages', async () => {
    const { calls, pub } = setup();
    await pub.update('demo-htx-abcd', [files[0]], 'Sửa demo lần 1');
    const seq = calls.filter((c) => !c.path.endsWith('/access_tokens')).map((c) => `${c.method} ${c.path.replace('/repos/Demo-Org/demo-htx-abcd', '')}`);
    expect(seq).toEqual(['GET /git/ref/heads/main', 'GET /git/commits/headsha', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main']);
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/commits'))!.body.message).toBe('Sửa demo lần 1');
  });

  it('status: built → ready with html_url; otherwise pending; 404 → pending', async () => {
    let page: { status: number; body?: unknown } = { status: 200, body: { status: 'built', html_url: 'https://demo-org.github.io/demo-x-abcd/' } };
    const { pub } = setup((c) => c.path.endsWith('/pages') && c.method === 'GET' ? page : undefined);
    expect(await pub.status('demo-x-abcd')).toEqual({ state: 'ready', url: 'https://demo-org.github.io/demo-x-abcd/' });
    page = { status: 200, body: { status: 'built' } };
    expect(await pub.status('demo-x-abcd')).toEqual({ state: 'ready', url: 'https://demo-org.github.io/demo-x-abcd/' });
    page = { status: 200, body: { status: 'building', html_url: 'https://x/' } };
    expect(await pub.status('demo-x-abcd')).toEqual({ state: 'pending' });
    page = { status: 404, body: { message: 'Not Found' } };
    expect(await pub.status('demo-x-abcd')).toEqual({ state: 'pending' });
  });

  it('remove deletes the repo and tolerates 404', async () => {
    let n = 0;
    const { calls, pub } = setup((c) => c.method === 'DELETE' ? (n++ ? { status: 404, body: {} } : { status: 204 }) : undefined);
    await pub.remove('demo-x-abcd');
    await pub.remove('demo-x-abcd');
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/repos/Demo-Org/demo-x-abcd', '/repos/Demo-Org/demo-x-abcd']);
  });
});
