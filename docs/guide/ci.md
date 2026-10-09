# CI integration

> [English](ci.md) | [简体中文](zh-CN/ci.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

`teamai ci extract-mr --output <dir> --dry-run` refuses before provider access or artifact creation. It prints `teamai ci extract-mr --output has no --dry-run preview, nothing was run` and exits 1. Omit `--output` to preview, or omit `--dry-run` to write artifacts.

`teamai ci extract-mr` plugs into your CI pipeline, automatically extracting knowledge from every MR/PR:

```bash
# Comment mode: post suggestions as comments (runs when the MR/PR is opened/updated)
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write mode: after merge, write approved suggestions into the knowledge base
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

Workflow:

1. MR opened/updated → CI triggers `--mode comment`, extracts knowledge suggestions and posts them as MR comments
2. Reviewer reviews the comments, marking unwanted suggestions as rejected (GitHub 👎 / TGit ☝️)
3. MR merged → CI triggers `--mode write`, writing non-rejected suggestions into the team knowledge repo

If the review-status API returns a non-2xx response, write mode fails closed: the job exits without writing files, committing, or pushing to the team knowledge repo.

Comment mode also fails closed when it cannot list the existing marker comment, so a transient provider error cannot create a duplicate comment.

Ready-to-use templates, with setup notes, are in [`examples/ci/`](../../examples/ci/README.md).
