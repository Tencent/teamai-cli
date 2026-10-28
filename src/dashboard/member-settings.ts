/**
 * The Member settings panel's data (#1459): for the selected workspace, each member setting some level sets, the level
 * that won and the levels below it, as `teamai doctor` reports them, and the keys of a settings-only
 * ~/.teamai/config.yaml that no command reads.
 */
import { loadTeamConfig } from '../config.js';
import { machineUnreadKeys, memberSettingRows, memberSettingsReport, type MemberSettingRow } from '../member-settings-report.js';
import { getUserConfigPath, isSelfMode, type LocalConfig } from '../types.js';
import { getUserHome } from '../utils/home.js';

/** What the panel shows; `home` lets it name a file below the home directory from `~`. */
export type MemberSettingsPanel =
  | { configured: false }
  | { configured: true; scope: 'workspace' | 'self' | 'user'; home: string; machineFile: string; rows: MemberSettingRow[]; unread: string[] };

export async function readMemberSettingsPanel(config: LocalConfig): Promise<MemberSettingsPanel> {
  const teamConfig = await loadTeamConfig(config.repo.localPath);
  const [reports, unread] = await Promise.all([memberSettingsReport({ localConfig: config, teamConfig }), machineUnreadKeys()]);
  return {
    configured: true,
    scope: config.scope === 'user' ? 'user' : isSelfMode(config) ? 'self' : 'workspace',
    home: getUserHome(),
    machineFile: getUserConfigPath(),
    rows: memberSettingRows(reports),
    unread,
  };
}
