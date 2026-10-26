# Codex failure origin

Invariant: task content must not select provider credential repair or provider retry policy. Only provider errors can do that.

The CLI adapter scans all stdout when it classifies authentication, quota, and transient failures. Stdout also carries task messages and command results. A command result that discusses an application's HTTP 401 and Bearer handling can select OpenAI credential repair even when the terminal provider error reports model capacity. The ACP adapter also sends the final task summary into its auth classifier.

Use the existing Codex JSONL parser as the source of protocol failure text. For a protocol stream, classify its parsed error instead of item content. Preserve plain-text startup diagnostics for legacy errors. Do not scan incomplete JSON records as plain-text diagnostics. Keep stderr and the explicit runtime error message available. Remove the task summary from ACP authentication input.

This change belongs at error-text collection, which is shared by the CLI auth, quota, transient, and reset-time classifiers. Reordering quota ahead of auth would leave the same bug for other terminal errors. Removing all stdout would lose valid JSONL provider failures.

Cover task messages, command results, tool results, truncated records, current terminal errors, plain startup auth errors, and ACP summaries. Genuine expired, reused, and invalidated credentials must still select auth repair. Synthetic fixtures must contain no private task identifiers, logs, or credentials.

No schema, connection permissions, retry policy, or UI changes. An already persisted false connection request needs a separate operator-authorized withdrawal after deployment. Withdrawal already queues a continuation. Use an exact failed-run retry only if no continuation was queued. Do not submit a new OpenAI credential to clear a false request.
