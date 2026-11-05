export function parseWorkerTiming(env = process.env) {
  const maxSeconds = Number.parseInt(env.WORKER_MAX_SECONDS ?? "20400", 10);
  const renewalLeadSeconds = Number.parseInt(env.WORKER_RENEWAL_LEAD_SECONDS ?? "900", 10);

  if (!Number.isFinite(maxSeconds) || maxSeconds < 60 || maxSeconds > 21000) {
    throw new Error("WORKER_MAX_SECONDS must be between 60 and 21000");
  }

  // Managed VMs are stopped by the VM orchestrator. They do not dispatch a
  // replacement workflow, so the legacy self-renewal lead time is irrelevant.
  if (!env.VM_ID && (
    !Number.isFinite(renewalLeadSeconds) ||
    renewalLeadSeconds < 60 ||
    renewalLeadSeconds >= maxSeconds
  )) {
    throw new Error("WORKER_RENEWAL_LEAD_SECONDS must be at least 60 and less than WORKER_MAX_SECONDS");
  }

  return { maxSeconds, renewalLeadSeconds };
}
