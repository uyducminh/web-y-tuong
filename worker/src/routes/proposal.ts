import type { Proposal, SiteJson } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { errorJson, json } from '../http';
import { getJson } from '../kv';
import { pagesUrl } from '../jobs';

export async function getProposal(deps: Deps, siteId: string): Promise<Response> {
  const [meta, proposal, site] = await Promise.all([
    getJson<SiteMeta>(deps.kv, `site:${siteId}`),
    getJson<Proposal>(deps.kv, `proposal:${siteId}`),
    getJson<SiteJson>(deps.kv, `sitejson:${siteId}`),
  ]);
  if (!meta || !proposal) return errorJson(404, 'Không tìm thấy bản đề xuất này.');
  return json({ proposal, site: { name: site?.brand.name ?? meta.name, url: meta.url ?? pagesUrl(deps.config, meta.repo) } });
}
