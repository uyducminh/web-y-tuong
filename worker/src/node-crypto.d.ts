// Minimal typing for the node:crypto subset we use (available in Workers via nodejs_compat).
// We avoid @types/node because it conflicts with @cloudflare/workers-types globals.
declare module 'node:crypto' {
  interface Hmac { update(data: string): Hmac; digest(encoding: 'hex'): string }
  export function createHmac(algorithm: 'sha256', key: string): Hmac;
}
