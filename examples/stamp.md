# Stamp examples

Emit a block to paste into a PR description (or use `--trailers` / `--token`).

## Local session (author-private)

```bash
pr-session stamp --agent claude --id 70b1d898-bfab-4739-8b75-fcf61b53e470
```

```markdown
<!-- pr-session:begin -->
**Agent session (Claude Code):** `agent-session://claude/70b1d898-bfab-4739-8b75-fcf61b53e470`
_Transcript is local to the author machine — not visible to reviewers. Use `pr-session lookup` locally._
<!-- pr-session:end -->
```

Reviewers see that a session exists; they cannot open the transcript. You can:

```bash
pr-session lookup org/repo#123 --min exact
```

## Cloud session (shareable)

```bash
pr-session stamp \
  --agent cursor \
  --id bc-abc123 \
  --cloud-url 'https://cursor.com/agents/bc-abc123' \
  --title 'Fix auth race'
```

```markdown
<!-- pr-session:begin -->
**Agent session (Cursor):** `agent-session://cursor/bc-abc123`
Shareable transcript: https://cursor.com/agents/bc-abc123
Session: Fix auth race
<!-- pr-session:end -->
```

## Commit trailers

```bash
pr-session stamp --agent codex --id 019a4faf-ce63-7b11-98a5-a9966f0f6e0d --trailers
```

```
Agent-Session: codex/019a4faf-ce63-7b11-98a5-a9966f0f6e0d
```

Machine-only token:

```bash
pr-session stamp --agent claude --id 70b1d898-bfab-4739-8b75-fcf61b53e470 --token
# → agent-session://claude/70b1d898-bfab-4739-8b75-fcf61b53e470
```
