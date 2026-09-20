# Scenario: Member — publish a reusable skill

Goal: the user turns something they built into team knowledge everyone can pull.
**Any member can do this — you do not need to be an admin.** The usual entry point
is the user just asking in plain language, e.g. *"share this xxx skill with my
team"* / *"把这个 xxx skill 分享给团队"* — then you run the publish for them.

## Which kind of contribution?

- **A learning** (a lesson, a gotcha, how you solved something) → this is
  **automatic**: TeamAI prompts at the end of a session worth sharing and the
  dedicated **`teamai-share-learnings`** skill takes over (it summarizes the
  session and runs `teamai contribute`). The user does not come through this flow
  for it. (Step A below is only a manual fallback for when that skill isn't
  available.)
- **A reusable skill** (a `SKILL.md` others invoke) → author the skill, then
  `teamai push` (Step B — the main purpose of this reference).

## Step A — Contribute a learning by hand (fallback only)

> Prefer the **`teamai-share-learnings`** skill. Use these manual steps only if it
> is unavailable in the current tool.

1. Write a short Markdown doc that captures the lesson. Keep it concrete and
   actionable — a knowledge base, not a diary. Include YAML frontmatter for search
   indexing:

   ```markdown
   ---
   title: "<short title of the problem or finding>"
   author: <username>
   date: <YYYY-MM-DD>
   tags: [tag1, tag2, tag3]
   ---

   ## Background
   What were you doing? What went wrong?

   ## Solution
   How did you fix it? Key steps.

   ## Takeaways
   - Lesson 1
   - Lesson 2
   ```

2. Save it to a temp file, then push it to the team:

   ```bash
   teamai contribute --file /tmp/my-learning.md --title "K8s pod startup timeout"
   ```

The doc lands in the team's `learnings/` and appears for teammates on their next
`teamai pull`. It is also searchable via `teamai recall`.

> Tip: if there is a dedicated learnings skill available in this tool
> (`teamai-share-learnings`), you can use it to auto-summarize the current session
> instead of writing the doc by hand.

## Step B — Contribute a reusable skill

1. Create the skill directory with a `SKILL.md`:

   ```
   skills/my-skill/SKILL.md
   ```

   Minimal frontmatter:

   ```markdown
   ---
   name: my-skill
   description: "One line — what it does and when to use it"
   ---

   # My Skill

   Step-by-step instructions the AI should follow.
   ```

2. Publish it:

   ```bash
   teamai push --skill skills/my-skill        # one skill
   # or
   teamai push                                # review and push everything
   ```

   To publish into a specific role namespace: `teamai push --skill <path> --role <id>`.

## After contributing

- Confirm it landed: `teamai list skills` (or `teamai status`).
- Teammates receive it automatically on their next session, or via `teamai pull`.

## If push is denied

A permission error usually means you don't have write access to the team repo.
Copy the exact error to your admin and ask them to grant access. (In read-only
HTTP mode, `contribute` / `push` are not available — you can only consume.)
