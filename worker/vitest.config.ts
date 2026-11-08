import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
  test: {
    css: { include: [/templates\/.*\.css/, /static\/package\/.*\.css/] },
    poolOptions: { workers: { singleWorker: true, miniflare: { compatibilityDate: '2025-09-06', compatibilityFlags: ['nodejs_compat'], kvNamespaces: ['KV'] } } },
  },
});
