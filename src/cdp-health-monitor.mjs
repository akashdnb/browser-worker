const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpHealthMonitor {
  constructor({
    probe,
    recover,
    onNotReady = () => {},
    onReady = () => {},
    onError = (error) => console.error("CDP health monitor callback failed:", error),
    intervalMs = 5000,
    failureThreshold = 2,
    startupDeadlineMs = 300_000,
    backoffBaseMs = 1000,
    backoffMaxMs = 30_000,
    sleep = defaultSleep,
  } = {}) {
    if (typeof probe !== "function") throw new TypeError("probe must be a function");
    if (typeof recover !== "function") throw new TypeError("recover must be a function");
    for (const [name, value, minimum] of [
      ["intervalMs", intervalMs, 100],
      ["failureThreshold", failureThreshold, 1],
      ["startupDeadlineMs", startupDeadlineMs, 1000],
      ["backoffBaseMs", backoffBaseMs, 1],
      ["backoffMaxMs", backoffMaxMs, 1],
    ]) {
      if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be at least ${minimum}`);
    }
    if (backoffMaxMs < backoffBaseMs) throw new Error("backoffMaxMs must be greater than or equal to backoffBaseMs");

    this.probe = probe;
    this.recoverBackend = recover;
    this.onNotReady = onNotReady;
    this.onReady = onReady;
    this.onError = onError;
    this.intervalMs = intervalMs;
    this.failureThreshold = failureThreshold;
    this.startupDeadlineMs = startupDeadlineMs;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.sleep = sleep;
    this.failures = 0;
    this.ready = false;
    this.started = false;
    this.stopped = false;
    this.timer = undefined;
    this.recoveryPromise = null;
  }

  start({ initiallyReady = false } = {}) {
    if (this.started || this.stopped) return;
    this.started = true;
    this.ready = Boolean(initiallyReady);
    this.#schedule(this.intervalMs);
  }

  forceRecovery(reason = "Browser backend recovery requested") {
    return this.#recover(reason);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get isReady() {
    return this.ready;
  }

  #notify(callback, ...args) {
    try {
      callback(...args);
    } catch (error) {
      this.onError(error);
    }
  }

  #schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.#tick(), delayMs);
    this.timer.unref?.();
  }

  async #tick() {
    if (this.stopped) return;
    try {
      const result = await this.probe();
      const healthy = typeof result === "boolean" ? result : Boolean(result?.healthy);
      if (healthy) {
        this.failures = 0;
        if (!this.ready && !this.recoveryPromise) {
          void this.#recover("Chromium CDP endpoint recovered");
        }
      } else {
        this.failures += 1;
        if (this.failures >= this.failureThreshold) {
          const reason = typeof result === "object" && result?.reason
            ? String(result.reason)
            : "Chromium CDP endpoint is unavailable";
          void this.#recover(reason);
        }
      }
    } catch (error) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold) {
        void this.#recover(error instanceof Error ? error.message : String(error));
      }
    }
    this.#schedule(this.intervalMs);
  }

  async #recover(reason) {
    if (this.stopped) return false;
    if (this.recoveryPromise) return this.recoveryPromise;

    this.recoveryPromise = (async () => {
      this.ready = false;
      this.#notify(this.onNotReady, reason);
      let attempt = 0;

      while (!this.stopped) {
        const deadline = Date.now() + this.startupDeadlineMs;
        try {
          await this.recoverBackend({ reason, deadline, attempt });
          if (this.stopped) return false;
          this.ready = true;
          this.failures = 0;
          this.#notify(this.onReady);
          return true;
        } catch (error) {
          const delayMs = Math.min(this.backoffMaxMs, this.backoffBaseMs * (2 ** attempt));
          const detail = error instanceof Error ? error.message : String(error);
          this.#notify(
            this.onNotReady,
            `${reason}; recovery attempt ${attempt + 1} failed: ${detail}; retrying in ${delayMs}ms`,
          );
          await this.sleep(delayMs);
          attempt += 1;
        }
      }
      return false;
    })().finally(() => {
      this.recoveryPromise = null;
    });

    return this.recoveryPromise;
  }
}
