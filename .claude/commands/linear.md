Use repo-local GraphQL helpers to read and write Linear through `LINEAR_API_KEY`.

Read the full skill at `.agents/skills/linear/SKILL.md` for available queries, workflows, and rules.

Primary path — run the repo-local helper:

```bash
python3 .agents/skills/linear/scripts/linear_graphql.py \
  --query-file .agents/skills/linear/queries/<query>.graphql \
  --variables '<json>'
```

Available queries are in `.agents/skills/linear/queries/`. Reference docs are in `.agents/skills/linear/references/`.

$ARGUMENTS
