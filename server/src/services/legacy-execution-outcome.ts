import type { heartbeatRuns } from "@paperclipai/db";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { claimedAdapterType, hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh model turn cannot repair or verify unrestored files.
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) return true;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && (run.errorCode === "ai_connection_busy" || run.errorCode === "ai_connection_pool_exhausted") &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** A terminal legacy run whose outcome is otherwise unknown and that its
 * executor may still prove stopped before any provider work: a shutdown during
 * paperclip_runner bootstrap, or a Stop or queued-message interrupt that
 * cancelled the run before its adapter ran. */
export function isLegacyBootstrapStopCandidate(
  run: Pick<Run, "runtimeMode" | "runtimeModeResolvedAt" | "status" | "errorCode" | "processPid" | "processGroupId" | "runnerProfileJson" | "resultJson">,
): boolean {
  if (run.runtimeMode !== "legacy" || run.processPid || run.processGroupId) return false;
  const stopped = run.status === "cancelled" || (run.status === "interrupted" && run.errorCode === "server_shutdown_interrupted" &&
    !run.runtimeModeResolvedAt && claimedAdapterType(run) === "paperclip_runner");
  return stopped && legacyExecutionNeedsReconciliation(run);
}
