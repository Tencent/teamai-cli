# Unified dashboard

The logo's charcoal/blue palette, four-module navigation, English/Simplified Chinese UI and light/dark/system themes replace the previous session-only layout. All data comes from the existing local collectors and KB report aggregation.

## Functional mapping

| View | Retained functionality |
| --- | --- |
| Overview | Local session status/counts, six current/prior 7-day metrics, KB coverage, maintenance candidate counts, session list |
| Team Execution | All supported tools, exact working-directory/tool filters, active and recently ended sessions, first/latest secret-redacted prompt summaries and output previews, duration, last activity/tool, intervention and token counts; keyboard-accessible Details opens all captured prompt summaries (capped at 200 characters), safely rendered Markdown output and full breakdowns |
| Team Context | Original KB totals, coverage by type, top recalled chart, expandable never-recalled groups, last-recall month chart, author contribution table, reported data scope and report generation time |
| Team Improvement | Local trends, original promotion/archive/stale candidate guidance and commands, digest/session-save/share-learnings command references |

Maintenance commands remain read-only guidance. No new CLI command or browser mutation endpoint is introduced. `/kb-report` remains the complete original standalone report, including maintenance.

## Implementation

- `dashboard-html.ts` embeds the shell, styles, locale catalog and browser application from `src/dashboard/` into one HTML response. No remote assets or package asset-copy step.
- Existing `/api/sessions`, `/events`, `/api/trends`, `/api/kb-summary` and `/kb-report` stay available. `/api/context` reuses `buildVizData` and the original escaped report section renderers, with a 30-second cache and coalesced concurrent requests.
- SSE reconnects after failure. A 15-second session reconciliation poll also applies the collector's existing idle and 30-second ended-session rules without requiring another hook event. Relative times update every five seconds without replacing the focused row.
- Fetch failures have retry controls. Previous successful KB/trend values remain visibly marked as stale on refresh failure. No missing metric is converted into a fabricated zero.
- Local redacted prompt summaries and output remain local and are escaped before HTML/Markdown rendering. Knowledge titles, authors, commands and session content are not translated. Locale/theme preferences are stored only in browser storage and gracefully degrade if it is blocked.
- `generatedAt` describes report generation, not team synchronization. No cross-machine live status, recall penetration, adoption rate, automated improvement workflow or causal improvement claims are added.

## Cost semantics

The dashboard adds `avgSessionCostMicros` and `pricedSessions` to each `/api/trends` period. The cohort is sessions whose first Stop falls in that UTC seven-day period. Sum each cohort session's available priced request costs, including resumed requests, and divide by sessions with at least one priced request. A known zero-cost session counts; sessions without priced usage do not. Display coverage alongside the estimate. The estimate may be partial when some models are unpriced.

The existing `avgRequestCostMicros`, request-day daily buckets and digest statistics are unchanged for compatibility. Never derive session cost by dividing request-day totals by first-Stop-day session counts: those populations can differ across midnight or resumed sessions.

## Validation

- TypeScript and production CLI build.
- Unit regression for script syntax, existing report sections/XSS escaping, session-cost denominator, period boundaries, zero/unpriced sessions and resumed sessions.
- Built CLI end-to-end tests use isolated offline git/gitlab/github provider configurations, each with Claude, Codex, CodeBuddy and OpenCode events. Validate sessions, SSE changes, cost fields, full KB report, original summary endpoint and new context endpoint. This does not claim remote provider authentication or agent-binary integration testing.
- Browser checks cover light/dark themes, locale persistence, filtering, keyboard dialog, original Markdown output and KB sections. No private user telemetry is used in fixture tests.

### Verification record (2026-09-16)

- `npx tsc --noEmit` and `npm run build`: passed.
- Full `npx vitest run`: 234 files / 3,268 tests passed. After final UI refinements, reran dashboard UI, collector, session-trends and viz suites: 116 tests passed.
- Built CLI `dashboard-unified` E2E: all three offline provider fixtures passed, four agent event formats in each.
- Browser: light and dark rendering, English/Chinese round-trip and reload persistence, tool filter, dialog details with Markdown code/table output, escaped HTML fixture, KB sections and maintenance headings verified.
- Started the final built CLI against local data: `/api/sessions`, `/api/trends`, `/api/context`, `/api/kb-summary` all returned HTTP 200; SSE showed connected.

### Workspace selection and missing data

The sidebar switches between all local sessions, user scope, and installed project scopes. Project partitions are discovered from their anchor files; legacy installs are discovered from the startup directory and recorded session directories. Linked Git worktrees share a project. User scope contains sessions outside installed projects. In the all-workspaces view, knowledge uses the startup scope; this is labeled explicitly. Individual scopes select their own knowledge configuration, with separate report caches and stale-response protection. Restart the dashboard after installing a new scope.

The complete health report is split between Team Context (coverage, recalls, entries, authors) and Team Improvement (maintenance), with internal navigation. The legacy report URL remains compatible, but is not linked from the dashboard. Missing prior-period samples are labeled as no ended sessions, no priced sessions, or no usage data rather than collecting.
