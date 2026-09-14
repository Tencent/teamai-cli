/**
 * adapters/base.ts — AgentAdapter 抽象基类与 SessionMeta。
 *
 * 所有平台适配器（Claude Code / Codex / CodeBuddy / Cursor）都继承 AgentAdapter，
 * 实现统一的 list/read/write/delete 接口，使上层迁移逻辑与具体平台解耦。
 */

import type { Session } from '../ir.js';

export interface SessionMeta {
  sessionId: string;
  title: string;
  cwd: string;
  platform: string;
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
  messageCount: number;
  filePath?: string;
  sizeBytes: number;
}

export abstract class AgentAdapter {
  static readonly platform: string;

  abstract get platform(): string;

  /** 列出该平台指定项目（工作目录）下的所有会话。projectPath 为 undefined 时列出所有。 */
  abstract listConversations(projectPath?: string): Promise<SessionMeta[]>;

  /** 读取单个会话，返回归一化 IR Session。 */
  abstract readSession(sessionId: string, projectPath?: string): Promise<Session>;

  /** 将归一化 IR Session 写入目标平台，返回写入后的 session ID。 */
  abstract writeSession(session: Session, projectPath?: string): Promise<string>;

  /**
   * 删除目标平台上的会话（用于回滚）。
   *
   * 返回值用于区分「真的删掉了」和「压根没找到」：
   * - `false` —— 确认没有任何东西被删除（会话不存在）
   * - `true` / `undefined` —— 已删除，或该适配器不检测存在性（沿用原有行为）
   *
   * 之所以允许返回 void：多数适配器不具备存在性检测能力，
   * 为回滚的可观测性改动全部适配器不划算，未实现的保持 undefined 即可。
   */
  abstract deleteSession(sessionId: string, projectPath?: string): Promise<boolean | void>;

  /** 检测该平台 CLI 是否已安装且可用（静态，检查基础路径）。 */
  static isAvailable(): boolean {
    return false;
  }

  /** 检测该适配器实例的存储路径是否可用（实例方法，变体可覆盖）。 */
  isReady(): boolean {
    return false;
  }

  /** 返回该平台会话的默认存储根路径。 */
  static getDefaultStoragePath(): string {
    return '';
  }
}
