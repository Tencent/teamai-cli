/**
 * The Member settings panel's data (#1459): for the selected workspace, each member setting some level sets, the level
 * that won and the levels below it, as `teamai doctor` reports them, and the keys of a settings-only
 * ~/.teamai/config.yaml that no command reads.
 */
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import { machineUnreadKeys, memberSettingRows, memberSettingsReport, type MemberSettingRow } from '../doctor.js';
import { getTeamaiHomeDir, isSelfMode, type LocalConfig } from '../types.js';

export type MemberSettings =
  | { configured: false }
  | { configured: true; scope: 'workspace' | 'self' | 'user'; machineFile: string; rows: MemberSettingRow[]; unread: string[] };

export async function readMemberSettings(config: LocalConfig): Promise<MemberSettings> {
  const teamConfig = await loadTeamConfig(config.repo.localPath);
  const [reports, unread] = await Promise.all([memberSettingsReport({ localConfig: config, teamConfig }), machineUnreadKeys()]);
  return {
    configured: true,
    scope: config.scope === 'user' ? 'user' : isSelfMode(config) ? 'self' : 'workspace',
    machineFile: path.join(getTeamaiHomeDir(), 'config.yaml'),
    rows: memberSettingRows(reports),
    unread,
  };
}
