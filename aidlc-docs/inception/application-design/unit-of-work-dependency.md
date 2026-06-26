# Unit of Work — Dependency Matrix & Build Order

## Dependency Matrix

`✓` = row unit **depends on** column unit (compile/runtime dependency).

| depends on →    | U1 | U2 | U3 | U4 | U5 |
|-----------------|----|----|----|----|----|
| **U1 Bootstrap/Config** | —  |    |    |    |    |
| **U2 Notion Tracker**   | ✓  | —  |    |    | ✓  |
| **U3 Orchestrator**     | ✓  | ✓  | —  | ✓  | ✓  |
| **U4 Workspace/Agent**  | ✓  |    |    | —  | ✓  |
| **U5 Observability**    | ✓  |    |    |    | —  |

Notes:
- **U1** is the foundation (domain types, config, prompt renderer, validation) — no dependencies.
- **U2** and **U4** depend on U1 and consume the U5 logger; they are independent of each other.
- **U3** is the integrator: it consumes the `TrackerClient` (U2), `AgentRunner` + `WorkspaceManager`
  (U4), config/validation (U1), and the logger/status (U5).
- **U5** depends only on U1 (domain/state types) so logs/status can render orchestrator state.
- U2↔U4 decoupling is enforced via interfaces defined in U1's `domain/` (keeps backends swappable).

## Critical Path
```
U1  ──►  U2  ─┐
   └──►  U5  ─┼──►  U3   (orchestrator wires everything; runnable walking skeleton)
   └──►  U4  ─┘
```

## Recommended Build / Dispatch Order
1. **U1 — Bootstrap, CLI & Config** (unblocks everything; defines interfaces + domain types).
2. **U5 — Observability** (small; needed by U2/U3/U4 for logging).
3. **U2 — Notion Tracker** and **U4 — Workspace & Agent Runner** — can proceed in **parallel**
   (both depend only on U1 + U5).
4. **U3 — Orchestrator Core** (last; integrates U2 + U4 into the poll loop → end-to-end skeleton).

## Integration Checkpoint
After U3, the walking skeleton runs end-to-end: poll Notion → pick one eligible issue → create a
sanitized workspace → run Claude Code once (high-trust) → stop on terminal state → structured logs +
terminal status. This is the MVP success criterion (`execution-plan.md` → Success Criteria).
