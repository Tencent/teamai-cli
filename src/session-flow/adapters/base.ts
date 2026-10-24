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
  /** Absent when the tool's listing does not count messages (OpenCode). */
  messageCount?: number;
  /**
   * Where the session lives: its transcript file, or on CodeBuddy IDE its conversation directory.
   * Pass it back as `SessionReadRef.filePath` to read exactly this session.
   */
  filePath?: string;
  /** Absent when the tool's listing does not measure it (OpenCode). */
  sizeBytes?: number;
}

/** Which session `readSession` opens. */
export interface SessionReadRef {
  /** The id the session is listed under. Codex also accepts a suffix of 8+ characters. */
  sessionId: string;
  /** The workspace to look in. */
  projectPath?: string;
  /**
   * The `SessionMeta.filePath` the adapter listed: a transcript file on every platform except
   * CodeBuddy IDE, where it is the conversation directory, and OpenCode, which lists none (its
   * sessions live behind its CLI, where one id names one session). When set, exactly that is
   * read, so a caller that enumerated sessions never opens another copy with the same id.
   */
  filePath?: string;
}

/** One agent a session started, as the tool stored it. */
export interface Subagent {
  session: Session;
  /** 1 for an agent the session started, 2 for one that agent started, and so on. */
  depth: number;
  /** Whether the tool recorded that the agent finished; absent when the tool records nothing either way. */
  finished?: boolean;
  /**
   * Whether the tool recorded where the agent's own work starts, for a tool that copies the parent's history into the
   * agent's; `unknown` keeps the whole record, which may open with context the agent inherited.
   */
  start?: 'recorded' | 'unknown';
}

/** The agents a session started, in the order it started them, or why they could not be read. */
export type SubagentsRead = { status: 'read'; agents: Subagent[] } | { status: 'unread'; reason: string };

/**
 * Thrown by an adapter whose tool CLI cannot run on this machine (absent, or too old), or whose
 * store cannot be read.
 * `AgentSession` reports it as `tool_unavailable`, never as a missing session.
 */
export class ToolUnavailableError extends Error {
  override name = 'ToolUnavailableError';
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

  /** List every session under the given project (working directory) on this platform. When projectPath is undefined, list all. `archived` adds the sessions the platform archived. */
  abstract listConversations(projectPath?: string, options?: { archived?: boolean }): Promise<SessionMeta[]>;

  /**
   * Read one session and return a normalized IR Session. Lookup order: `filePath`, then the id in
   * `projectPath`, then (Cursor, WorkBuddy, CodeBuddy IDE and OpenCode, or when no `projectPath`
   * is given) the id across the platform. The returned `sessionId` is the id of the session opened, never
   * the one requested.
   */
  abstract readSession(ref: SessionReadRef): Promise<Session>;

  /**
   * The id this platform stores `sessionId` under, when anything with that id exists, or undefined.
   *
   * A lookup by id across all of the platform's storage, not a computed path, and without parsing:
   * a copy the client is writing at that moment, or one that no longer parses, still exists.
   * With `projectPath`, only that workspace counts, the same scope `deleteSession` uses.
   */
  abstract existingSessionId(sessionId: string, projectPath?: string): Promise<string | undefined>;

  /**
   * The agents `session` started, read from where the tool keeps them, in the order it started them. Only `find` asks,
   * and only when its caller does, so a copy, a migration or an archive never carries them.
   */
  async readSubagents(session: Session, _ref: SessionReadRef): Promise<SubagentsRead> {
    return { status: 'unread', reason: `TeamAI does not read the subagents of ${session.platform} sessions` };
  }

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
