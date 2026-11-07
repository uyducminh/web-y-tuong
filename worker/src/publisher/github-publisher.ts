import type { TemplateId } from '@sme/schema';
import { GithubError, type GithubClient } from '../clients/github';
import type { Publisher, PublishFile } from './types';

export type GithubPublisherOpts = {
  gh: GithubClient; org: string;
  /** Written into the template's `<meta name="lead-endpoint">` (the Worker's public base URL). */
  leadEndpoint: string;
  sleep?: (ms: number) => Promise<void>;
};

const NOT_READY_RETRIES = 5;
const NOT_READY_DELAY_MS = 2000;

const utf8ToB64 = (s: string): string => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64ToUtf8 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export function setLeadEndpoint(html: string, endpoint: string): string {
  const safe = endpoint.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html.replace(/<meta\s+name=["']?lead-endpoint["']?\s+content=(["'])[^"']*\1\s*\/?>/i,
    `<meta name="lead-endpoint" content="${safe}">`);
}

export function makeGithubPublisher(o: GithubPublisherOpts): Publisher {
  const { gh, org } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const repoPath = (repo: string) => `/repos/${org}/${repo}`;

  /** A freshly generated repo answers 404/409 for a few seconds; retry those every 2s, at most 5 times. */
  async function whenReady<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!(e instanceof GithubError) || (e.status !== 404 && e.status !== 409) || i >= NOT_READY_RETRIES) throw e;
        await sleep(NOT_READY_DELAY_MS);
      }
    }
  }

  /** All files in one commit via the Git Data API: blobs → tree(base_tree) → commit → move refs/heads/main. */
  async function commit(repo: string, files: PublishFile[], message: string): Promise<void> {
    const R = repoPath(repo);
    const ref = await whenReady(() => gh.request<{ object: { sha: string } }>('GET', `${R}/git/ref/heads/main`));
    const head = ref.object.sha;
    const headCommit = await whenReady(() => gh.request<{ tree: { sha: string } }>('GET', `${R}/git/commits/${head}`));
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
    for (const f of files) {
      const blob = await whenReady(() => gh.request<{ sha: string }>('POST', `${R}/git/blobs`, { content: f.base64, encoding: 'base64' }));
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await whenReady(() => gh.request<{ sha: string }>('POST', `${R}/git/trees`, { base_tree: headCommit.tree.sha, tree }));
    const c = await whenReady(() => gh.request<{ sha: string }>('POST', `${R}/git/commits`, { message, tree: newTree.sha, parents: [head] }));
    await whenReady(() => gh.request('PATCH', `${R}/git/refs/heads/main`, { sha: c.sha, force: false }));
  }

  async function patchedIndex(template: TemplateId): Promise<PublishFile> {
    const r = await gh.request<{ content: string }>('GET', `${repoPath(template)}/contents/index.html`);
    return { path: 'index.html', base64: utf8ToB64(setLeadEndpoint(b64ToUtf8(r.content), o.leadEndpoint)) };
  }

  return {
    async create({ repoName, template, files }) {
      await gh.request('POST', `${repoPath(template)}/generate`, { owner: org, name: repoName, private: false });
      const index = await patchedIndex(template);
      const all = [...files.filter((f) => f.path !== 'index.html'), index];
      await commit(repoName, all, 'Tạo bản dùng thử');
      try {
        await whenReady(() => gh.request('POST', `${repoPath(repoName)}/pages`, { source: { branch: 'main', path: '/' } }));
      } catch (e) {
        // 409 after retries means Pages is already enabled
        if (!(e instanceof GithubError && e.status === 409)) throw e;
      }
      return { repo: repoName };
    },

    async update(repo, files, message) {
      await commit(repo, files, message);
    },

    async status(repo) {
      let p: { status?: string; html_url?: string };
      try { p = await gh.request('GET', `${repoPath(repo)}/pages`); } catch (e) {
        if (e instanceof GithubError && e.status === 404) return { state: 'pending' };
        throw e;
      }
      if (p?.status !== 'built') return { state: 'pending' };
      return { state: 'ready', url: p.html_url || `https://${org.toLowerCase()}.github.io/${repo}/` };
    },

    async remove(repo) {
      try { await gh.request('DELETE', repoPath(repo)); } catch (e) {
        if (!(e instanceof GithubError && e.status === 404)) throw e;
      }
    },
  };
}
