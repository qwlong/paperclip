# Decision continuation implementation plan

> Execute inline with `superpowers:executing-plans`; no delegation. Spec and plan are self-reviewed under the user's standing instructions.

**Goal:** decision outcomes arriving during an active issue run reach a subsequent eligible run.

**Architecture:** extend the existing `RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP` policy in `server/src/services/heartbeat/queue.ts`. The decision bridge and durable release path remain unchanged.

**Tech stack:** TypeScript, Vitest, isolated embedded PostgreSQL, controlled WebSocket gateway.

- [x] Run the existing approval deferral control with `nice -n 19 pnpm --dir server exec vitest run src/__tests__/heartbeat-comment-wake-batching.test.ts -t 'defers approval-approved wakes' --maxWorkers=1`.
- [x] Add parameterized gateway tests to `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`, using `createDecisionWakeOriginAgent` and the existing fixture helpers. Cover decided, expired, cancelled, and completed-issue suppression. Old code failed all six cases because it returned the active run instead of deferring input.
- [x] Add `"decision_decided"`, `"decision_expired"`, and `"decision_cancelled"` to the existing follow-up set. Six new cases and the approval control pass, with distinct run IDs and provider-visible wake reasons.
- [x] Remove each new reason separately and verify its outcome test fails, restoring the exact source after each mutation. Run the affected test file, `git diff --check`, and a scoped server typecheck; preserve baseline failures rather than claiming a clean full build.
- [x] Read the final diff independently, keep private operational evidence outside the repository, and prepare a fork PR using the repository template. Do not merge or restart the live service without the user's merge/deploy confirmation.

Review focus: provider execution after release is evidence; a changed database context alone is not. No authorization bypass, artificial board identity in agent flows, background model invocation, or changes to other companies' tasks.

## Verification record

- The first baseline could not load the plugin SDK. Building the existing shared/plugin prerequisites resolved that setup failure. Embedded PostgreSQL then lacked hydrated native library links because dependency scripts were disabled; its package's hydration script restored them. The unchanged approval control then passed.
- The first gateway fixture omitted required completion comments and a valid review wait path. Existing recovery correctly generated unrelated follow-ups. The corrected fixture writes each simulated run's own final comment, maintains a future monitor while waiting, and finishes the second run's task. This fixes fixture validity; no production recovery guard was weakened.
- Each new reason was removed separately. Its two outcome tests failed on the intended coalescing assertion. The implementation was restored and its hash checked after all three mutations.
- Final regression: all 37 tests in `heartbeat-comment-wake-batching.test.ts` and `decision-wakeup.test.ts` passed. `git diff --check` passed. All test processes exited.
- A direct server typecheck reports 155 diagnostics, including unavailable Runner build outputs and an existing parent-directory OpenTelemetry dependency. Removing the three implementation lines produced exactly the same diagnostics. No full build or whole-repository test claim is made from this isolated checkout.
- Related upstream PR [#17478](https://github.com/paperclipai/paperclip/pull/17478) changes continuation worker scheduling and acknowledgement. Its diff does not change active-run wake admission; this patch addresses that separate boundary.
