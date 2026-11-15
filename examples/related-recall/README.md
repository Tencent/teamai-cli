# Declared-relation recall pilot

This synthetic two-task pilot checks setup and provenance for #1564, not recall effectiveness.

1. In a disposable environment, copy `project/` to a separate Git remote, commit, and push. Record the full project SHA.
2. Copy `team/` into a fresh TeamAI team remote. Commit and push the rules and docs. Record that full SHA as the with-relations revision.
3. Branch from that commit, remove only the YAML frontmatter from the two rules, commit and push. Record the without-relations SHA. Check that the diff contains only the two `related:` blocks and their delimiters, with no changes to rule bodies or docs.
4. On the team default branch, materialize each `.yaml.in` as `.yaml`. Fill in the project URL and SHA, the two team SHAs, and one concrete Claude model for both arms. Commit and push the suite. The suite is loaded from the pulled team revision; the trial resources are pinned separately.
5. Use a fresh team with no learnings, or freeze its learnings branch and record its SHA before and after the experiment. Pinned team commits alone do not pin that branch.

Use a configured TeamAI workspace (not self mode) on a disposable runner with Claude and Node:

```sh
teamai pull
teamai benchmark run related-recall --sandbox --task retry-delay > pilot.json
```

Omit `--task` to run both fixed tasks. Save the run ID, project and arm revisions, resolved tool and model, recall flags, and learnings SHA or absence. For each task, look for the corresponding rule hit and outgoing `REFERENCES` line in recall output from the trial's scope. Match the indexed rule and doc to the pinned Git blobs. The control should still have the same rule body and doc but no declared outgoing edge. If the transcript never queries recall or the index revision cannot be verified, record that evidence as missing; a passing code check cannot substitute for it.

No model-run results are included. One repetition is a smoke check, not an estimate of the effect of declared relations.
