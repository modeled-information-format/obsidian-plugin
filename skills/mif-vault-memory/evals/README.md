# Test cases for the mif-vault-memory skill

Each folder is one case: `prompt.md` (the user's words), `case.yaml` (what a
good result is) and `graders/` (one checkable statement each).

These cases need a connected `mif-vault` server, which `claude plugin eval`
does not start. Run them with the repository's own runner, which starts a
throwaway in-memory vault for every run and tries each case with and without
the skill:

```bash
node scripts/eval-skill.mjs
```

It writes each run's answer, tool calls and the notes the run changed under
`skills/mif-vault-memory-workspace/`, which git ignores.
