import { readGiteaText } from './gitea-api.js';

// Unknown HTTP remote → anonymous version probes → explicit configuration hint.

/** A compatible version endpoint is a hint, not permission to send a PAT. */
export async function probeSelfHostedGitea(
  input: string,
  timeoutMs = 3_000,
): Promise<{ baseUrl: string; version: string } | null> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || parts.some((part) => !part || /[\s\\]/.test(part))) return null;
  const suffix = parts.at(-2) === 'pulls' && /^\d+$/.test(parts.at(-1) ?? '') ? 4 : 2;
  if (parts.length < suffix) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
  });
  const probe = async (): Promise<{ baseUrl: string; version: string } | null> => {
    for (let length = parts.length - suffix; length >= 0; length--) {
      const baseUrl = url.origin + (length ? `/${parts.slice(0, length).join('/')}` : '');
      try {
        const response = await fetch(`${baseUrl}/api/v1/version`, {
          headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'manual', signal: controller.signal,
        });
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); continue; }
        const { text } = await readGiteaText(response, 128 * 1024);
        const data = JSON.parse(text) as { version?: unknown };
        if (typeof data.version === 'string' && data.version.trim()) return { baseUrl, version: data.version };
      } catch {
        if (controller.signal.aborted) return null;
      }
    }
    return null;
  };
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
