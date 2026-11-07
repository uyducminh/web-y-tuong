export function makeTurnstile(secret: string | undefined, fetchFn: typeof fetch = fetch) {
  return {
    async verify(token: string, ip: string): Promise<boolean> {
      if (!secret || !token) return false;
      try {
        const body = new URLSearchParams({ secret, response: token, remoteip: ip });
        const r = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
        const j = (await r.json()) as { success?: boolean };
        return j.success === true;
      } catch { return false; }
    },
  };
}
