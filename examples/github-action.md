# Future: GitHub Action plug-in

The CLI and `pr-session/local` are **author-machine only**. An Action must not
run `buildIndex()` against runner disks that lack your transcripts.

Use the pure core instead:

```ts
import { extractStampTokens } from "pr-session/stamp";
import { resolveSessionsForPr } from "pr-session/resolve";

const stamps = extractStampTokens(prBody);
// Only surface matches that already carry a cloud/shareable URL.
```

Sketch (not shipped — do not `npm install -g` a local-only index lookup):

```yaml
# .github/workflows/pr-session.yml (future)
name: pr-session
on:
  pull_request:
    types: [opened, edited, synchronize]
jobs:
  attribute:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install pr-session   # once published
      - name: Surface cloud stamps from PR body
        run: |
          node <<'EOF'
          import { extractStampTokens } from 'pr-session/stamp';
          const body = process.env.PR_BODY || '';
          for (const s of extractStampTokens(body)) {
            console.log(`${s.agent}/${s.sessionId}`);
          }
          EOF
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
```

Local transcripts must not be uploaded by the Action. Keep indexing on the
author machine; the Action should only surface `agent-session://…` stamps that
already include a shareable URL.
