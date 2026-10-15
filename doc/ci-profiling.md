# Profile the complete PR suite

Add the `profile-ci` label to a PR authored by a CI CODEOWNER. Adding the label starts a fresh `PR` workflow
run. Further pushes while the label remains also run with profiling enabled.
The run is named **CI profile · PR #number**. It runs all lanes of the main PR
suite, including middle-of-stack and release-notes-only PRs that normally skip
most lanes.

After the run finishes, open its Summary and follow **Open the Honeycomb
waterfall**. The separate **CI profile** workflow exports the trace after all
jobs finish. Its summary has the exact time range, job/span counts, and coverage
warnings. Keep the label on the PR and its head unchanged until export finishes.
Remove the label to stop profiling subsequent pushes. To profile the same
revision again, remove and re-add the label or rerun all jobs.

The PR author, original workflow actor, and rerun actor must all be individual
users in the trusted `master` branch's `.github/**` CODEOWNERS rule. GitHub user
IDs are resolved from that rule; PR edits to CODEOWNERS cannot grant access.
A label on an outside contributor's PR does not enable profiling, even when a
maintainer applies it. Failed identity lookups disable profiling.

Ordinary PRs do not write timing artifacts or export traces. The exporter job is
skipped for ordinary run names. Adding another label does not run the CI matrix.

Profiling preserves the existing trusted AWS runner routing. Eligible PR jobs
use `paperclip-public-pr-x64`; the routing gate uses `paperclip-ci-routing-x64`.
The existing fail-closed GitHub-hosted fallback still applies if AWS routing
cannot be authorized. Only the separate post-run Honeycomb exporter uses
`ubuntu-latest` directly; it is outside the measured PR suite.

## Read the waterfall

The workflow root measures elapsed time from run creation to the last job's
completion. For reruns, it starts at that attempt's `run_started_at` instead of
the original creation time. Every job is a child on the same wall clock, with
its steps and available test details beneath it. All spans use a sample rate of
one. There is no sampling within the selected attempt. For a compact Gantt view,
open a job row's menu and choose **Collapse spans at this depth**. Expand an
individual job to inspect its steps and test files.

The expandable hierarchy is **workflow → job → step → test filename → tests**.
Vitest, Playwright, and Node file rows use repository-relative filenames, also
available in `test.file`. Separate files retain their own children even when
individual test names repeat across files.

- Compare the jobs that finish last (`ci.finishes_last`) with other overlapping
  work. A long job that finishes early is not necessarily delaying CI.
- Expand setup, dependency installation, cache restore, Rust compilation, builds,
  and tests to find repeated or slow work.
- `ci.execution_ms` measures a job's execution. `ci.start_offset_ms` shows when
  it started relative to the whole run. Do not add parallel job durations to
  calculate elapsed time.
- Waiting spans cover job creation to runner start. Dependency waits can occur
  before GitHub creates a job, so they appear as gaps from the workflow start.
  GitHub does not expose a separate ready timestamp; do not interpret every gap
  as runner queue time or claim this is a computed dependency critical path.

GitHub job/step timestamps have second precision. Vitest and Playwright record
test timestamps at the runner. Node's test reporter records completion receipt
time and duration (`test.clock=reporter-receipt`); buffered IPC delivery can shift
those small test spans. Vitest file spans include its test/hook execution and
carry collection/setup durations as fields. Playwright file spans cover the
first through last test attempt in that file. Rust and standalone script checks
retain their full job/step timings; stable libtest does not expose per-test wall
timestamps. The trace is CI timing data, not application tracing.

Scope includes all main PR lanes: policy, typecheck/release registry, general and
serialized tests, Runner checks, Docker context checks, build, canary dry run,
browser E2E, and aggregate checks. Separate Storybook, image, deployment, release,
and live-provider eval workflows are outside this trace.

## Failure, coverage, and reruns

The exporter uses GitHub's attempt-specific job API and paginates jobs and
artifacts. It includes failed and cancelled jobs and uploads available test
timings with `always()`. A force-cancelled or failed setup job may leave no
artifact. Coverage warnings and `ci.profile_complete=false` make missing
artifacts, interrupted reporters, rejected data, and absent test details visible.
Test launchers write an expected-invocation record before starting each Vitest,
Playwright, or Node process. Each reporter must write matching start/end records,
so a missing reporter cannot hide behind another successful invocation in the
same job. Compare `ci.expected_invocations` with `ci.reported_invocations`.
Failed or cancelled workflows are conservatively incomplete because a failed
command can prevent later tests or steps from running.

Each attempt gets a different trace ID. Rerunning failed jobs alone produces an
attempt trace for those jobs; it does not replay completed jobs. Reruns are marked
`ci.partial_rerun=true` conservatively. Use a fresh label-triggered run for an
unambiguous full-suite baseline. GitHub may carry earlier successful jobs into
the new attempt's job inventory. Jobs completed before the new attempt started
are excluded and counted in `ci.carried_job_count`.

If export fails, inspect **CI profile** and rerun that exporter after fixing the
cause. A partial HTTP export may already have sent some spans; retries use the
same IDs but the Events API does not promise deduplication. Timing artifacts
remain available for 14 days. Invalid/oversized artifacts stop export instead of
silently truncating the suite. No logs, environment dumps, error messages, stack
traces, or credentials are included in the exported field allowlist.

## Operator setup and activation

Use the existing Honeycomb `paperclip` team, `test` environment, and a separate
service dataset named `paperclip-ci`. Create GitHub environment `ci-profiling` with **Selected branches and tags**:
allow only the branch `master`, with no PR-ref or tag patterns. Store environment
secret `HONEYCOMB_CI_API_KEY` with a dedicated ingest-only key for the Honeycomb
`test` environment. Do not create a repository- or organization-level secret of
that name: the environment restriction prevents in-repository PR workflows from
requesting the key. Tests still execute the PR branch; only the separate exporter
runs from `master`. It needs event
ingest permission; dataset creation permission is needed only if the dataset
has not been created yet. Do not store the environment configuration key in CI.
Create the repository label `profile-ci` if it does not exist.

`ci-profile.yml` runs from the trusted default-branch revision. It checks out only
the exporter, installs no dependencies, and parses PR artifacts as bounded JSON
without extracting or executing their contents. The PR jobs never receive the
Honeycomb key. The exporter independently verifies CI CODEOWNER identities,
the current label, repository, and exact tested PR revision before reading
artifacts or sending data. Its credential is sent only in an HTTPS header to
`api.honeycomb.io`; redirects are rejected. Exported fields are allowlisted.
`CODEOWNERS` also covers `scripts/ci-profile/**`, so changes to the privileged
exporter require infrastructure-owner review.

The new trusted workflow and routing definitions must merge to master before
the label-triggered journey is active. A PR uses `pr-trusted.yml@master` and
`ci-routing.yml@master`; do not change those trust references just to test this
feature before merge.

## Local qualification

```sh
node --test .github/scripts/tests/ci-profile.test.mjs .github/scripts/tests/ci-routing.test.mjs
node --test scripts/ci-profile/reporters.test.mjs
actionlint .github/workflows/{pr,pr-trusted,ci-routing,ci-profile}.yml
node scripts/ci-profile/export.mjs --run-id=RUN_ID --attempt=1 --historical --dry-run --output=/tmp/ci-trace.json
```

`--historical` is local-only and permits a deliberate export of an existing
unlabeled run. It has complete GitHub job/step timing but cannot reconstruct
test details that were never recorded. Omit `--dry-run` and supply
`HONEYCOMB_CI_API_KEY` to send the selected baseline to Honeycomb. It is labeled
as historical/incomplete test coverage; it is not proof of the label-triggered
workflow.

References: [Honeycomb trace fields](https://docs.honeycomb.io/get-started/best-practices/organizing-data/),
[Events API](https://docs.honeycomb.io/api/events/create-events),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
