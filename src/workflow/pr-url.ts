import { z } from 'zod';

const MAX_LENGTH = 512;

/**
 * A pull request URL safe to store and publish: https on any host and path, no credentials, no query or fragment, at
 * most 512 characters. Parsing a sanitized value gives it back unchanged, so a stored URL parses to itself.
 */
export const PrUrlSchema = z.string().transform((value, ctx) => {
  const clean = sanitize(value);
  if ('reason' in clean) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: clean.reason });
    return z.NEVER;
  }
  return clean.url;
}).brand<'PrUrl'>();
export type PrUrl = z.infer<typeof PrUrlSchema>;

function sanitize(value: string): { url: string } | { reason: string } {
  if (value.length > MAX_LENGTH) return { reason: `exceeds ${MAX_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: 'is not a valid URL' };
  }
  if (url.protocol !== 'https:') return { reason: 'must use HTTPS' };
  if (url.username || url.password) return { reason: 'contains credentials' };
  url.search = '';
  url.hash = '';
  const sanitized = url.toString();
  return sanitized.length <= MAX_LENGTH ? { url: sanitized } : { reason: `exceeds ${MAX_LENGTH} characters` };
}

/** Why a reported URL was not kept is said without the value, which may hold a token. */
export function sanitizePrUrl(value: unknown): { url: PrUrl; reason?: never } | { url?: never; reason: string } {
  if (typeof value !== 'string') return { reason: 'must be a URL string' };
  const parsed = PrUrlSchema.safeParse(value);
  return parsed.success ? { url: parsed.data } : { reason: parsed.error.issues[0]?.message ?? 'is not a valid URL' };
}
