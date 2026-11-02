import { z } from 'zod';

const PROBE_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

/** Derive a web origin without forwarding URL credentials or SSH ports. */
function webOrigin(input: string): string | null {
  const trimmed = input.trim();

  try {
    const scp = trimmed.match(/^([^@\s/:]+)@([^:\s/?#]+):(.+)$/);
    const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : trimmed);

    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;

    if (url.password || (url.protocol !== 'ssh:' && url.username)) return null;

    if (url.search || url.hash || !url.hostname) return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/');

    if (segments.length < 2 || segments.some((part) => !part || /[\s\\]/.test(part))) return null;

    return url.protocol === 'ssh:' ? `https://${url.hostname}` : url.origin;
  } catch {
    return null;
  }
}

/** GitLab's `x-gitlab-meta` header: a JSON object with a non-empty `correlation_id` and `version`. */
const GitLabMetaSchema = z.looseObject({ correlation_id: z.string().min(1), version: z.string().min(1) });

function hasGitLabHeader(response: Response): boolean {
  const value = response.headers.get('x-gitlab-meta');

  if (!value) return false;

  try {
    return GitLabMetaSchema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

/** Match structured login-page markers, not a page that merely mentions GitLab. */
function hasGitLabHtml(html: string): boolean {
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  const hasApiVersion = scripts.some((match) => /\bgon\.api_version\s*=\s*(["'])v4\1/.test(match[1]));

  if (!hasApiVersion) return false;
  const withoutScripts = markup.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');

  return [...withoutScripts.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) => {
    const attributes = new Map(
      [...tag.matchAll(/\s([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3]]),
    );

    return attributes.get('property') === 'og:site_name' && attributes.get('content') === 'GitLab';
  });
}

/**
 * Best-effort anonymous identification of a self-hosted GitLab web root.
 * This is a configuration hint, not permission to send a token to this host.
 * Custom web ports for SSH remotes and relative-URL-root deployments still
 * require an explicit GITLAB_URL. Never follow redirects to an SSO service.
 */
export async function probeSelfHostedGitLab(
  input: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ baseUrl: string } | null> {
  const baseUrl = webOrigin(input);

  if (!baseUrl) return null;
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  const probe = async (): Promise<{ baseUrl: string } | null> => {
    try {
      response = await fetch(`${baseUrl}/users/sign_in?auto_sign_in=false`, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html' },
      });

      if (!response.ok && response.status !== 401 && response.status !== 403) return null;

      if (hasGitLabHeader(response)) return { baseUrl };

      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('text/html')) return null;
      reader = response.body?.getReader();

      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > MAX_RESPONSE_BYTES) return null;
        chunks.push(value);
      }

      return hasGitLabHtml(Buffer.concat(chunks).toString('utf8')) ? { baseUrl } : null;
    } catch {
      return null;
    }
  };

  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
    // Cancellation must not extend the overall timeout for a stalled body.
    void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
  }
}
