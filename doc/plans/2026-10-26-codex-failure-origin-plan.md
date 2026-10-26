# Codex failure origin implementation plan

Use executing-plans in this session. Self-review the design and plan before implementation.

**Goal:** Keep task content out of Codex provider-failure recovery decisions.

**Architecture:** Reuse the JSONL parser in the shared error-text collector. Keep native startup diagnostics. Remove ACP task summaries from credential-failure classification.

**Tech stack:** TypeScript, Vitest, existing Codex adapter fixtures.

- [x] Add parse regressions for protocol item content that quotes auth, capacity, or transient errors. Include a terminal capacity error next to task output about HTTP 401 and Bearer. Check genuine structured auth errors and incomplete JSON records. Run the affected file and confirm the new regressions fail for the intended classification.
- [x] Change `packages/adapters/codex-local/src/server/parse.ts` to classify parsed protocol errors and safe plain-text startup diagnostics. Keep explicit error messages and stderr. Rerun parse tests.
- [x] Add a failed ACP run whose task summary quotes an auth failure. Remove only the summary from auth-classification input in `acp.ts`. Run the new case and the existing genuine-auth case.
- [x] Replay the private failing stream locally without publishing it. Confirm auth is null and capacity remains classified as quota. Restore a deliberate item-content mutation and confirm the regression fails, then restore the source.
- [ ] Run adapter typecheck and affected tests at low concurrency. Use CI for full repository checks because the main checkout serves a live instance. Open a fork PR with the required template. Ask for merge/deploy approval before changing the live service, persisted connection request, or failed-run state.

Review focus: genuine provider auth must remain repairable; task prose and tool failures must not become provider auth; raw startup compatibility and quota reset extraction must remain intact.
