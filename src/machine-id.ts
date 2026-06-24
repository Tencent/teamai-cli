/**
 * Machine identity + local agent id derivation (Agent Status Reporting).
 *
 * Design contract (issue #1 / iWiki §5.2):
 *   local_agent_id = sha1(agent_type + machine_id + path_hash)[:16]
 *     path_hash    = sha1(install_path)[:8]      # only hashed locally, never reported
 *   instance_id    = local-<agent_type>-<local_agent_id last 6 hex>
 *
 * Invariants:
 *   - install_path never leaves the machine — it only feeds the local hash (privacy boundary).
 *   - Pure derivation, no disk writes — same machine + install dir + agent_type ⇒ same id.
 *   - machine_id falls back to empty string when unavailable (no MAC fallback).
 *
 * Cross-platform machine_id sources (macOS / Windows are first-class):
 *   - macOS:   IOPlatformUUID via `ioreg -rd1 -c IOPlatformExpertDevice`
 *   - Windows: MachineGuid via `reg query HKLM\SOFTWARE\Microsoft\Cryptography`
 *   - Linux:   /etc/machine-id or /var/lib/dbus/machine-id
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let cachedMachineId: string | null = null;

/**
 * Read this host's stable machine id. Result is cached for the process lifetime.
 *
 * Never throws — any failure (command missing, permission denied, unsupported
 * platform) resolves to an empty string. The reporter must never assume bash
 * exists; each platform branch calls native binaries directly via execFileSync.
 */
export function getMachineId(): string {
  if (cachedMachineId !== null) return cachedMachineId;
  cachedMachineId = detectMachineId();
  return cachedMachineId;
}

/** @internal — exported for tests that need to bypass the cache. */
export function detectMachineId(platform: NodeJS.Platform = process.platform): string {
  try {
    switch (platform) {
      case 'darwin':
        return readDarwinMachineId();
      case 'win32':
        return readWindowsMachineId();
      default:
        return readLinuxMachineId();
    }
  } catch {
    return '';
  }
}

function readDarwinMachineId(): string {
  const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
    encoding: 'utf-8',
    timeout: 3000,
  });
  const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return match ? match[1].trim() : '';
}

function readWindowsMachineId(): string {
  // Use reg.exe directly — do not assume a POSIX shell is present on Windows.
  const out = execFileSync(
    'reg',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { encoding: 'utf-8', timeout: 3000 },
  );
  const match = out.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i);
  return match ? match[1].trim() : '';
}

function readLinuxMachineId(): string {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const content = fs.readFileSync(p, 'utf-8').trim();
      if (content) return content;
    } catch {
      // try next source
    }
  }
  return '';
}

function sha1Hex(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

/**
 * Derive the stable 16-hex local_agent_id.
 *
 * @param agentType   Normalized agent id (e.g. "codebuddy", "workbuddy").
 * @param machineId   Result of getMachineId() (may be empty string).
 * @param installPath The agent resource root (e.g. ~/.codebuddy). Hashed locally only.
 */
export function deriveLocalAgentId(agentType: string, machineId: string, installPath: string): string {
  const pathHash = sha1Hex(installPath).slice(0, 8);
  return sha1Hex(`${agentType}${machineId}${pathHash}`).slice(0, 16);
}

/**
 * Derive the human-friendly instance id: local-<agent_type>-<last 6 hex of local_agent_id>.
 */
export function deriveInstanceId(agentType: string, localAgentId: string): string {
  return `local-${agentType}-${localAgentId.slice(-6)}`;
}
