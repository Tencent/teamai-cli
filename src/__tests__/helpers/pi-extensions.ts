import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { buildPiExtensionSource } from '../../pi-hooks.js';
import { buildOmpExtensionSource } from '../../omp-hooks.js';

/** One `teamai hook-dispatch` the generated extension ran: its argv and the JSON it wrote on STDIN. */
export interface ExtensionDispatch {
  args: string[];
  payload: Record<string, unknown>;
}

/** The ExtensionContext fields the extensions read: Pi and OMP share `cwd` and `sessionManager`; OMP adds `agent`. */
export interface ExtensionContext {
  cwd: string;
  sessionManager?: { getSessionId: () => string; getSessionFile?: () => string | undefined };
  agent?: { kind: 'main' | 'sub'; id: string; name: string; depth?: number; parentId?: string };
}

export type ExtensionHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

export interface LoadedExtension {
  /** The handler the extension registered for each host event. */
  on: Record<string, ExtensionHandler>;
  /** Fills as the handlers run. */
  dispatches: ExtensionDispatch[];
}

/** Evaluate an extension body (an ESM default export) in `context` and register its handlers. */
function register(source: string, context: Record<string, unknown>): Record<string, ExtensionHandler> {
  const body = source.replace(/^import .*;$/gm, '').replace(/export default /g, 'const __x = ');
  const factory = vm.runInNewContext(`${body}\n__x`, context) as (pi: { on: (event: string, handler: ExtensionHandler) => void }) => void;
  const on: Record<string, ExtensionHandler> = {};
  factory({ on: (event, handler) => { on[event] = handler; } });
  return on;
}

/** The generated Pi extension, whose `child_process.spawn` records each dispatch instead of running `teamai`. */
export function loadPiExtension(stdoutFor: (args: string[]) => string = () => ''): LoadedExtension {
  const dispatches: ExtensionDispatch[] = [];
  const spawn = (_command: string, argv: string[]) => {
    // Node now receives the installed CLI entry before the dispatcher arguments.
    const args = argv.slice(1);
    const child = new EventEmitter() as EventEmitter & { stdin: EventEmitter & { end: (s: string) => void }; stdout: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (stdin: string) => {
        dispatches.push({ args, payload: JSON.parse(stdin) as Record<string, unknown> });
        queueMicrotask(() => {
          const stdout = stdoutFor(args);
          if (stdout) child.stdout.emit('data', stdout);
          child.emit('close', 0);
        });
      },
    });
    child.kill = () => undefined;
    return child;
  };
  const on = register(buildPiExtensionSource(), { spawn, process: { platform: 'linux' }, setTimeout, clearTimeout });
  return { on, dispatches };
}

/**
 * The generated OMP extension, whose Bun shell (`$`) records each dispatch
 * instead of running `teamai`: the launcher is the first value, argv the second, and the
 * STDIN the Response redirected into it.
 */
export function loadOmpExtension(stdoutFor: (args: string[]) => string = () => ''): LoadedExtension {
  const dispatches: ExtensionDispatch[] = [];
  const $ = (_strings: TemplateStringsArray, _launcher: string[], args: string[], stdin: Response) => {
    const run = (async () => {
      dispatches.push({ args, payload: JSON.parse(await stdin.text()) as Record<string, unknown> });
      return stdoutFor(args);
    })();
    const output = Object.assign(run, { text: async () => run });
    return { quiet: () => ({ nothrow: () => output }) };
  };
  const on = register(buildOmpExtensionSource(), { $, Response, fs, path, Buffer });
  return { on, dispatches };
}
