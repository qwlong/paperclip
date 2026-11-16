# Interaction scope implementation plan

> Use superpowers:executing-plans in the existing isolated worktree.

**Goal:** Preserve broader execution wakes behind frozen interaction runs.
**Architecture:** Heartbeat supplies current gate facts; wake-queue owns coalescing
policy and pending-context normalization; existing release dispatch owns successors.
**Tech stack:** TypeScript, Vitest, Drizzle, isolated embedded PostgreSQL.

- [x] Read the WIP and reproduce assertions on its parent implementation. Back up
  the three source files, substitute `git show HEAD^:<path>`, run the changed
  use-case tests and full-scope heartbeat cases, and restore bytes in `finally`.
- [x] Restore `withoutScopeOfOpenGates(mergeCoalescedContextSnapshot(...),
  input.scopeGates)` in `server/src/modules/wake-queue/application/use-cases.ts`.
- [x] Complete `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`
  with running/queued/finished gate-release cases. Hold adapter completion with
  a promise; assert the original scope, deferred receipt, successor scope and
  success. Keep remaining-blocker and ordinary-comment controls.
- [x] Extend `server/src/modules/wake-queue/application/use-cases.test.ts` with
  mixed gate states, proving only open gates lose their pending scope fields.
- [x] Run these two test files from `server/` with
  `nice -n 19 pnpm exec vitest run <files> --maxWorkers=1`.
- [x] Starting from green, remove each new gate predicate / normalization branch
  separately, require assertion failures, then restore exact source bytes. Check
  the heartbeat-to-admission wiring with the integration cases.
- [x] Review the complete diff and run focused static checks. Document the scope
  contract in `doc/execution-semantics.md`.
- [x] Inspect process residue and prepare named-file commits, excluding the
  pre-existing lockfile modification.
- [ ] Push the feature branch to `fork` and open a PR using the repository
  template once GitHub access is available. Leave merge/deployment to the reviewer.

Review focus: gate truth comes from admission, scope stays frozen on live runs,
partial readiness is not authorization, pending comments survive normalization,
and tests wait for adapter execution rather than only the early running status.
Self-review: every spec scenario maps to a test above; no extra state or API is
introduced. Full-repository test/build runs are excluded on this production host.

## Verification record

- Parent implementation: six unit assertions fail (four bad coalesces and two
  stale deferred scopes); two public-heartbeat cases fail on persisted coalesced
  receipts instead of deferred receipts.
- Final focused suites: 98 passed (76 application tests, 22 heartbeat tests).
- Mutation checks: ten unit-level mutants and two heartbeat gate-wiring mutants
  each fail by assertion. Original source bytes were restored and compared.
- One intervening suite run was interrupted when host load rose to about 660;
  it is not counted as a pass. The final 98-test run completed after load fell.
- Real comments carry `wakeCommentId` and already defer behind running turns;
  the regression preserves that behavior and ordinary eligible-wake coalescing.
- Server-only `pnpm exec tsc --noEmit --incremental false` reports 155 diagnostics
  on both the parent and final implementation, with byte-identical output and no
  changed-file diagnostics. Missing runner declarations and the host-resolved
  OpenTelemetry dependency prevent a clean server typecheck in this checkout.
  No full-repository build or test suite was run.
- Fixture settlement: record per-run deliveries and finish full-scope fixture work
  to avoid spawning unrelated recovery work during teardown. The 22 heartbeat
  tests pass after this adjustment; all nine new scenarios pass separately with
  zero execution-setup errors. The remaining four late setup errors in the full
  file also reproduce on the unmodified parent (13 tests pass, four setup logs).
