declare module 'cloudflare:test' {
  interface ProvidedEnv { KV: KVNamespace }
}

declare module '*?raw' {
  const content: string;
  export default content;
}
