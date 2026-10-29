export function isRepoReference(value: string): boolean {
  if (/^[^/@]+@[^:/]+:.+$/.test(value)) return true;
  try {
    const parsed = new URL(value);
    // `new URL('C:\\teams\\repo')` accepts `c:` as a scheme; drive letters
    // are paths, not hosts — reject them so a path-only config keeps the
    // provider-and-team-slug fallback instead of hashing a phantom URL.
    if (/^[a-z]:$/.test(parsed.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}
