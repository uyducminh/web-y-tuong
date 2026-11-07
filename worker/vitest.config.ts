import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    poolOptions: { workers: { singleWorker: true, miniflare: { compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], kvNamespaces: ['KV'] } } },
  },
});
