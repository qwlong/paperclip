# Decision continuations received during a run

A decision resolved while its originating issue is running must remain actionable after that run finishes. Updating a persisted context that has already been sent to a provider does not deliver new input.

The decision service emits `decision_decided`, `decision_expired`, and `decision_cancelled` through `createDecisionWakeOriginAgent`. The wake queue already defers comments, structured interactions, and `approval_approved` behind an active issue execution. Legacy decision outcomes are missing from its existing follow-up policy, so their receipts can be marked coalesced into a run that never receives them.

Add all three outcomes to the existing running-issue follow-up policy. Retain the current queued-wake coalescing, execution locks, task eligibility, cancellation, and retry rules. Do not change decision effects, grant authorization, force new sessions, or shorten external reconciliation timers.

Verify the complete bridge-to-queue-to-provider path with synthetic companies in the existing isolated PostgreSQL/gateway harness. Hold the first provider turn open, resolve each outcome, assert a durable deferred receipt without modifying the active turn, then release the first turn and observe a distinct successful run with that outcome. Also close the issue before release and verify the deferred decision cannot restart a completed task. Existing approval/comment tests remain controls.

Review: covers all terminal decision outcomes and arrival during active execution; queued execution remains eligible to receive input before launch. This is a delivery fix, not permission to execute a decision's business effects. No production database or model calls are used by tests.
