/**
 * The team skills a finished session is judged with (#1469): the ones its checkout held as delivered, each with the
 * description it then had and the skills namespace it came from, and the ones it loaded. Built from a session's
 * captures, so a later pull changes nothing. The routing questions these let a team ask are a separate change.
 */

/** A team skill a session's checkout held as delivered, as the evidence lists it. A root skill has no `namespace`. */
export interface AvailableSkill {
  name: string;
  namespace?: string;
  description: string;
}

/** The skills part of a session's evidence: the team skills available to it, and the ones it loaded. */
export interface SkillsEvidence {
  available: AvailableSkill[];
  used: string[];
}

/** What one capture recorded of a delivered team skill: the description it then had, and its skills namespace if any. */
export interface CapturedSkill {
  namespace?: string;
  description: string;
}

/** The skills a capture recorded as delivered, by name; absent when the capture recorded no descriptions. */
export type SkillCaptures = ReadonlyArray<{ teamSkillInfo?: Readonly<Record<string, CapturedSkill>> }>;

/**
 * The skills evidence of a session from the descriptions its `captures` recorded, oldest first, and the skills it
 * `used`; or the `skills_unknown` gap when no capture recorded descriptions, as a capture written before #1469 does.
 * When captures differ, the available list is their union and the latest description of a name wins. Each description is
 * masked. `used` is the label's bare names, unchanged. A checkout with no team skills gives an empty list and no gap.
 */
export function skillsEvidence(
  captures: SkillCaptures,
  used: readonly string[],
  mask: (text: string) => string,
): { skills: SkillsEvidence } | { gap: 'skills_unknown' } {
  if (!captures.some((capture) => capture.teamSkillInfo !== undefined)) return { gap: 'skills_unknown' };
  const latest = new Map<string, CapturedSkill>();
  for (const capture of captures) {
    for (const [name, info] of Object.entries(capture.teamSkillInfo ?? {})) latest.set(name, info);
  }
  const available = [...latest.entries()]
    .map(([name, info]): AvailableSkill => ({ name, ...(info.namespace !== undefined ? { namespace: info.namespace } : {}), description: mask(info.description) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { skills: { available, used: [...used] } };
}
