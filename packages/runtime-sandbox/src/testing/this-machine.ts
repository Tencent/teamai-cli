import { z } from 'zod';

// The test bundle's `this-machine.ts`: the stand-ins' directory, the operating system and the os-release file a test
// names, or this machine's.

export const SYSTEM_BIN = process.env.SANDBOX_TEST_SYSTEM_BIN || '/usr/bin';

export const PLATFORM: NodeJS.Platform = z.enum(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd']).catch(process.platform).parse(process.env.SANDBOX_TEST_PLATFORM);

export const OS_RELEASE = process.env.SANDBOX_TEST_OS_RELEASE ? [process.env.SANDBOX_TEST_OS_RELEASE] : ['/etc/os-release', '/usr/lib/os-release'];
