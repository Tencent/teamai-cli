/** What a run holds once a delivery case ends, over every install that drove it. */
export interface DeliveryExpectation {
  /** Pull requests TeamAI asked the host to open. */
  creates: number;
  run: 'succeeded' | 'failed' | 'cancelled';
  work: 'succeeded' | 'failed' | 'cancelled';
  /** The pull requests the run lists in `deliveries` and its end record's `prs`. */
  prs: number;
  /** The failure code of `work`, whose message then names its branch. */
  failure?: string;
}

/**
 * A delivery case for every driver that takes workspace leases, run against `deliveryConformanceWorkflow` with a fake
 * provider every case shares. The runner gives the product an `https://github.com/<owner>/<repo>` origin that git
 * rewrites to a bare repository, and a fake `gh` that records each create and answers lookups from what it recorded.
 * With `hold`, the fake waits inside that call, a create once it recorded the request, until the runner has done
 * `action`: `crash` kills the process the call came from, and the driver calls `next` again; `publish` publishes the
 * run and kills that process, and a driver of a second install with its own checkout claims the run and drives it;
 * `cancel` cancels the run; `poll` holds a delivery that another process of the machine started after `work` reported,
 * while the driver under test calls `next`. A driver whose delivery never reaches `hold` runs to the end untouched.
 * `unreachable` fails every lookup. `opened` is expected of a driver that leaves the pull request to TeamAI, `reported`
 * of one that reports its own as `changes.pr_url`. After every case, `work`'s branch is on origin at its reported commit.
 */
export interface DeliveryConformanceScenario {
  name: string;
  hold?: { call: 'lookup' | 'create'; action: 'crash' | 'publish' | 'cancel' | 'poll' };
  unreachable?: true;
  opened: DeliveryExpectation;
  reported: DeliveryExpectation;
}

/** `ship` copies what the host holds when it runs to `SHIP_SAW`, which the runner sets: the open requests by then. */
export const deliveryConformanceWorkflow = `schemaVersion: v1alpha1
name: deliver
description: A step delivers its branch as a pull request, and the step that needs it runs once it is delivered.
steps:
  - id: work
    workspace: new
    command: node -e "require('fs').writeFileSync('work.txt', 'W')"
    deliver: pr
  - id: ship
    needs: [work]
    command: node -e "require('fs').copyFileSync(process.env.SHIP_OPEN, process.env.SHIP_SAW)"
`;

const DELIVERED: DeliveryExpectation = { creates: 1, run: 'succeeded', work: 'succeeded', prs: 1 };
const REPORTED: DeliveryExpectation = { creates: 0, run: 'succeeded', work: 'succeeded', prs: 1 };

export const workflowDeliveryConformanceScenarios: DeliveryConformanceScenario[] = [
  {
    name: 'a delivered branch opens one pull request into the run base, and the step that needs it runs once it is delivered',
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a delivery whose process stops inside the create finds the pull request on the next call and opens no other',
    hold: { call: 'create', action: 'crash' },
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a run published while it delivers, and claimed by another install with its own checkout, opens one pull request',
    hold: { call: 'create', action: 'publish' },
    opened: DELIVERED,
    reported: REPORTED,
  },
  {
    name: 'a run cancelled while its delivery looks for an open pull request opens none',
    hold: { call: 'lookup', action: 'cancel' },
    opened: { creates: 0, run: 'cancelled', work: 'cancelled', prs: 0 },
    reported: { creates: 0, run: 'cancelled', work: 'cancelled', prs: 0 },
  },
  {
    name: 'a run cancelled while its delivery opens the pull request lists it, and the step stays cancelled',
    hold: { call: 'create', action: 'cancel' },
    opened: { creates: 1, run: 'cancelled', work: 'cancelled', prs: 1 },
    reported: REPORTED,
  },
  {
    name: 'a delivery that cannot reach the host fails naming the branch, which stays on origin',
    unreachable: true,
    opened: { creates: 0, run: 'failed', work: 'failed', prs: 0, failure: 'delivery_failed' },
    reported: { creates: 0, run: 'failed', work: 'failed', prs: 0, failure: 'delivery_failed' },
  },
  {
    name: 'a driver polls while another process of its machine delivers, and gets the step that needs it once delivered',
    hold: { call: 'create', action: 'poll' },
    opened: DELIVERED,
    reported: REPORTED,
  },
];
