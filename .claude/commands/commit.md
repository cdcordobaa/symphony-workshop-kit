Create a well-formed git commit from current changes using session history for rationale and summary.

Read the full skill at `.agents/skills/commit/SKILL.md` for the complete process.

Steps:
1. Read session history for scope, intent, and rationale
2. Inspect working tree and staged changes (`git status`, `git diff`, `git diff --staged`)
3. Stage intended changes after confirming scope
4. Choose conventional type and scope (`feat`, `fix`, `refactor`, etc.)
5. Write subject line in imperative mood, <= 72 chars
6. Write body with summary, rationale, and test status
7. Commit with `git commit -F <file>` (use temp file for proper newlines)

$ARGUMENTS
