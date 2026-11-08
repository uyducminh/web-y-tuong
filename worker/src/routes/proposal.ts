import type { Proposal, SiteJson } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { errorJson, json } from '../http';
import { getJson } from '../kv';
import { MIN_PACKAGE_VND } from './checkout';
import { demoUrl, isPaid } from '../sites';

export async function getProposal(deps: Deps, siteId: string): Promise<Response> {
  const [meta, proposal, site, paid] = await Promise.all([
    getJson<SiteMeta>(deps.kv, `site:${siteId}`),
    getJson<Proposal>(deps.kv, `proposal:${siteId}`),
    getJson<SiteJson>(deps.kv, `sitejson:${siteId}`),
    isPaid(deps, siteId),
  ]);
  if (!meta || !proposal) return errorJson(404, 'Không tìm thấy bản đề xuất này.');
  // Purchasable packages: the ids POST /api/checkout accepts and the exact prices it charges
  // (proposal.packages is AI-written and has no ids, so the page renders these for checkout).
  const { packages, allowTestPrice } = deps.config;
  const sellable = packages
    .filter((p) => allowTestPrice || p.priceVnd >= MIN_PACKAGE_VND)
    .map(({ id, name, priceVnd, items }) => ({ id, name, priceVnd, items }));
  return json({
    proposal, site: { name: site?.brand.name ?? meta.name, url: demoUrl(deps.config, siteId) },
    packages: sellable, paid,
  });
}
