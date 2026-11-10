/**
 * Compare two semver version strings.
 * Handles prerelease suffixes: a version with prerelease (e.g. 1.2.3-beta.1)
 * is always older than the same numeric version without one (semver §11).
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split('-', 2);
  const [coreB, preB] = b.split('-', 2);

  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;

    if (pa > pb) return 1;

    if (pa < pb) return -1;
  }

  // Numeric cores are equal — prerelease is lower than release (semver §11)
  if (preA && !preB) return -1;

  if (!preA && preB) return 1;

  return 0;
}
