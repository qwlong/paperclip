# Preserve execution wakes across interaction scope gates

An admitted interaction-only run must not absorb a wake admitted after its gate
opens. Once dependencies are ready, the owner must receive a normal execution
round. A partially resolved dependency set must not grant normal execution.

The heartbeat queue already knows dependency readiness and the active tree hold.
Pass those facts to wake admission; do not infer readiness from a wake reason or
the absence of fields in its payload. Compare them with the active run's frozen
context. Defer a broader wake behind running or queued interaction runs using the
existing execution-lock and release machinery. Do not mutate an admitted run's
scope. When merging pending deferred wakes, remove only the scope fields for
gates that are now open, preserving comments and any gate that remains closed.

Alternatives rejected: upgrading the live run cannot update its already-delivered
instructions; disabling all coalescing would create redundant normal runs.

Acceptance covers dependency and tree-hold release while running, while queued,
and after completion; partial dependency completion; ordinary wake coalescing
and real-comment follow-up deferral under the existing `wakeCommentId` policy;
and deferred-context cleanup with one gate still closed. Verify persisted wakes,
successor runs, and adapter inputs against isolated PostgreSQL. The adapter is a
controlled test substitute; no live provider or production execution is claimed.

No schema changes, deployment, instance restart, or unrelated lockfile changes.
Self-review: requirements are bounded to wake admission and existing dispatch;
both permission preservation and eventual execution have explicit assertions.
