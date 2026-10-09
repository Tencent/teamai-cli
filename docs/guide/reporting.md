# Usage reporting

> [English](reporting.md) | [简体中文](zh-CN/reporting.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

By default, `teamai pull` commits session/usage stats into the team repo.
Pull waits up to 5 seconds for the reporting batch, then continues its other
work while reporting finishes. A late successful push still updates the local
reported snapshots. Skill usage is recorded per scope, in the data directory of
the project teamai is set up for where the session ran (or the user scope), so
each target reports only its own; a directory without teamai records none.


Dashboard sessions stay in one machine-wide `~/.teamai/dashboard/events.jsonl`,
but each event records a key of its scope's data home (a hash, not the path),
so a scope reports only the sessions recorded in it: a user-scope pull no
longer reports a project's sessions, and a project reports its Copilot sessions
and sessions started under a symlinked path. A session is reported once, whole,
by the scope it started in, even if it later moves into another project: its
Stop carries the whole transcript's totals, so a second scope would count them
again. 

Events recorded by an earlier release carry no key: the scope their
directory resolves to now reports them (a nested clone under a project resolves
to its own project or the user scope, not the enclosing project); events with
no directory, or one removed since, are reported by no one. 

Each scope also
keeps its own snapshot of what it already reported, and a session under a
reused fallback ID (Copilot's PID-based ID when it sends none) counts as new,
whichever scope reported the earlier one, while a resumed session
(`claude --resume`) keeps its ID and stays one session, reported by the scope
that first reported it wherever it is resumed; the first
report after upgrading starts from the snapshot every scope used to share, so
nothing is reported twice. A
target removes its usage events only after it confirms success; failed pushes
preserve them, up to the newest 5,000 (see below). The affected sync locks remain
held until reporting finishes, preventing another pull from racing the report.

This is best-effort reporting, not crash-safe delivery: termination between a
remote push and local acknowledgement can still cause duplicate statistics.
It does not provide durable per-target deduplication for partial multi-repo
reports. The 5-second wait limit does not cancel Git or force the CLI process
to exit while a subprocess is still running.

Teams that pull from a read-only remote (or simply don't want stat commits)
can turn this off in `teamai.yaml`:

```yaml
usageReport: false
```

Pull keeps each scope's usage file to its newest 5,000 events, dropping the
oldest after the report step. For an http source or a `usageReport: false`
team, that file is the only record `teamai stats` has, so it stays bounded
without going empty; a reporting scope whose report does not complete while
it holds more than 5,000 drops its oldest unreported events the same way. The
cap runs only after a report has removed the events it sent. Hook appends, the
report's truncate and the cap take one lock beside the usage file, so a rewrite
does not lose an event recorded while it runs. 

A hook that cannot take the lock
within ~250 ms records its event in a `*.pending-<id>.jsonl` file next to it,
which the next lock holder appends to the usage file; a rewrite that cannot take
it within ~5 s leaves the file as it is. A pending file gets no wider mode than
the usage file (owner-only while there is none). An in-workspace
`.teamai/.gitignore` ignores the lock, a rewrite's temp copy and the pending
files; `pull` and `push` add those entries to an existing single-repo one, and
the usage file's first pending file or rewrite adds them to an existing
project-scope one.

**Removing a skill another project reported into your `stats/`.** Before skill
usage was kept per scope, whichever project pulled next reported every
project's skills, so `stats/<user>.yaml` on `teamai-reports` can count a skill
that belongs to an unrelated repo. Those events recorded no directory, so
teamai cannot attribute them and never rewrites the file. Remove the entry by
hand, from a clone of your own so teamai's `reports-wt/` checkout is untouched:

```bash
git clone --branch teamai-reports --single-branch <team-repo-url> teamai-reports
cd teamai-reports
# delete the skill's entry under `skills:` in stats/<user>.yaml
git commit -am "stats: remove <skill> reported from another project"
git push origin teamai-reports
```

The next report reads the branch first, so the entry does not come back.
