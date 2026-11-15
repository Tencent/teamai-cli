/**
 * The environment variable that puts teamai's CLI bundle (`cli.ts`) in a fleet guardian's mode: its value is what the
 * guardian stops (`GuardianInput` JSON). The guardian sets it before it loads the bundle, which reads it before anything
 * else loads, and removes it. A module of its own, so the bundle's entry reads it without loading the fleet's code.
 */
export const FLEET_GUARDIAN_ENV = 'TEAMAI_FLEET_GUARDIAN';
