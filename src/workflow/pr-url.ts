/** Public run records accept HTTPS review links on any host, but never URL credentials or session parameters. */
export function sanitizePrUrl(value: unknown): { url: string; reason?: never } | { url?: never; reason: string } {
  if (typeof value !== 'string') return { reason: 'must be a URL string' };
  if (value.length > 512) return { reason: 'exceeds 512 characters' };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return { reason: 'must use HTTPS' };
    if (url.username || url.password) return { reason: 'contains credentials' };
    url.search = '';
    url.hash = '';
    const sanitized = url.toString();
    return sanitized.length <= 512 ? { url: sanitized } : { reason: 'exceeds 512 characters' };
  } catch {
    return { reason: 'is not a valid URL' };
  }
}
