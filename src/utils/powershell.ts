import fs from 'node:fs';
import path from 'node:path';

let resolvedPowerShell: string | undefined;

/**
 * Windows PowerShell by absolute path. The hook inherits whatever environment
 * its host hands over, and that environment need not carry a usable PATH (or
 * even `SystemRoot`), so probe the usual roots — once per process — and only
 * fall back to a PATH lookup when none of them holds the binary.
 */
export function windowsPowerShell(): string {
  if (resolvedPowerShell) return resolvedPowerShell;
  const roots = [process.env.SystemRoot, 'C:\\Windows', process.env.windir].filter(
    (r): r is string => !!r,
  );
  resolvedPowerShell = 'powershell.exe';
  for (const root of roots) {
    const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(candidate)) {
      resolvedPowerShell = candidate;
      break;
    }
  }
  return resolvedPowerShell;
}
