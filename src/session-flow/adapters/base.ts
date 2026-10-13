/**
 * adapters/base.ts — AgentAdapter abstract base class and SessionMeta.
 *
 * Every platform adapter (Claude Code / Codex / CodeBuddy / Cursor) extends AgentAdapter
 * and implements a shared list/read/write/delete interface so migration logic stays decoupled from a specific platform.
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

  private writeNotice: string | undefined;

  /**
   * The transcript is already on disk. A failed list registration must not
   * throw — that would look like the write never happened — but the command
   * has to show the warning instead of a silent success.
   */
  protected noteWrite(message: string): void {
    this.writeNotice = message;
  }

  consumeWriteNotice(): string | undefined {
    const notice = this.writeNotice;
    this.writeNotice = undefined;
    return notice;
  }

  abstract get platform(): string;

  /** List every session under the given project (working directory) on this platform. When projectPath is undefined, list all. */
  abstract listConversations(projectPath?: string): Promise<SessionMeta[]>;

  /** Read one session and return a normalized IR Session. */
  abstract readSession(sessionId: string, projectPath?: string): Promise<Session>;

  /** Write a normalized IR Session to the target platform and return the written session ID. */
  abstract writeSession(session: Session, projectPath?: string): Promise<string>;

  /**
   * Delete a session on the target platform (used for rollback).
   *
   * The return value distinguishes "actually deleted" from "not found at all": `false` means
   * nothing was deleted (the session does not exist, or it is outside the `projectPath` scope). Rollback must be able to report a
   * no-op — otherwise a script cannot tell whether rollback took effect. Every adapter must return an explicit boolean.
   */
  abstract deleteSession(sessionId: string, projectPath?: string): Promise<boolean>;

  /** Check whether this platform's CLI is installed and usable (static; checks the base path). */
  static isAvailable(): boolean {
    return false;
  }

  /** Check whether this adapter instance's storage path is usable (instance method; variants may override). */
  isReady(): boolean {
    return false;
  }

  /** Return the default storage root for this platform's sessions. */
  static getDefaultStoragePath(): string {
    return '';
  }
}
