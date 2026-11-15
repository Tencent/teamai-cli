/**
 * The OpenCode version a member runs, which decides how teamai delivers to it and launches it. In a module of its own,
 * so a test mocks it where every caller reads it.
 */
import { probeBinary } from '@teamai/shared/exec';
import { opencodeMajorOf } from '@teamai/tool-core/launch';

const majorVersions = new Map<string, Promise<number>>();

/**
 * OpenCode's major version, from `<binary> --version` (`opencode v2.0.24` on
 * V2, `1.18.35` on V1), asked once per binary per run. ASSUMED_OPENCODE_MAJOR
 * (V2) when the binary is absent, exits non-zero or takes over 5 s, which all
 * print nothing here, or prints no version (opencodeMajorOf).
 */
export function opencodeMajorVersion(binary = 'opencode'): Promise<number> {
  let version = majorVersions.get(binary);

  if (!version) {
    version = probeBinary(binary).then(opencodeMajorOf);
    majorVersions.set(binary, version);
  }

  return version;
}
