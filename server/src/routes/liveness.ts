import { Router, type RequestHandler } from "express";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";

/** Routine probes report process readiness without auth, SQL, or provider I/O.
 * Database readiness and signed bootstrap remain on /api/health. */
export function livenessRoutes(serverInfo?: ServerInfoSnapshot) {
  const router = Router();
  // The running process's commit is fixed at boot; read it once, not per probe.
  const commit = (serverInfo ? Promise.resolve(serverInfo) : getServerInfoSnapshot())
    .then((info) => (info.git.available ? info.git.fullSha : null))
    .catch(() => null);
  const respond: RequestHandler = async (_req, res) => {
    const ready = getStartupRecoveryState().phase === "ready";
    res.set("Cache-Control", "no-store").status(ready ? 200 : 503).json({
      status: ready ? "ok" : "starting",
      commit: await commit,
    });
  };
  router.head("/", respond);
  router.get("/", respond);
  return router;
}
