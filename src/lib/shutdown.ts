/**
 * Single owner of process termination.
 *
 * The process used to have three owners of shutdown (the telemetry handlers,
 * the Redis cleanup handlers and an unheld `app.listen` handle) and none of
 * them drained anything. This module owns SIGTERM/SIGINT and drains in one
 * fixed order:
 *
 *   1. stop accepting connections (server.close) and release idle sockets
 *   2. wait for in-flight requests, bounded by `timeoutMs`
 *   3. end the Postgres pool
 *   4. disconnect Redis
 *   5. flush telemetry last so spans export
 *   6. exit
 *
 * Every step is isolated: one failure is logged and the remaining steps still
 * run. The whole sequence is bounded by `timeoutMs`, and a second signal
 * forces an immediate exit.
 */

/**
 * Default budget (ms) for the whole drain sequence.
 * Read once at module load, following the convention in lib/http-timeout.ts.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

export interface ShutdownDeps {
  server: {
    close: (callback?: (err?: Error) => void) => unknown;
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  closePool: () => Promise<void>;
  disconnectRedis: () => Promise<void>;
  shutdownTelemetry: () => Promise<void>;
  timeoutMs?: number;
  log?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
}

type LogFn = (message: string, error?: unknown) => void;

const defaultLog: LogFn = (message, error) => {
  if (error === undefined) {
    console.log(message);
  } else {
    console.error(message, error);
  }
};

/**
 * Close the HTTP server and resolve when it has drained.
 * Idle keep-alive sockets are released immediately after `close()` so they do
 * not hold the close open until their own idle timeout; sockets that are
 * serving a request are left alone so the request can finish.
 */
function closeServer(server: ShutdownDeps["server"]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    try {
      server.close((error?: Error) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    try {
      server.closeIdleConnections?.();
    } catch {
      // Best effort: failing to drop idle sockets must not fail the close.
    }
  });
}

/**
 * Build the shutdown handler. The returned function is idempotent: the first
 * call drains, any later call logs once and exits with code 1 because a second
 * signal means the operator wants the process gone now.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal?: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const log: LogFn = deps.log ?? defaultLog;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  let started = false;

  return async function shutdown(signal?: string): Promise<void> {
    if (started) {
      log(`Shutdown already in progress, forcing exit (signal: ${signal ?? "unknown"})`);
      exit(1);
      return;
    }
    started = true;

    log(`Received ${signal ?? "shutdown signal"}, starting graceful shutdown`);

    let timedOut = false;
    let currentStep = "server.close";
    let signalTimeout: () => void = () => undefined;
    const timeoutReached = new Promise<void>((resolve) => {
      signalTimeout = resolve;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        deps.server.closeAllConnections?.();
      } catch (error) {
        log("Failed to close active connections after shutdown timeout", error);
      }
      log(
        `Shutdown timed out after ${timeoutMs}ms while waiting for "${currentStep}"; continuing with remaining steps`,
      );
      signalTimeout();
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    let failed = false;

    const runStep = async (name: string, step: () => Promise<void>): Promise<void> => {
      currentStep = name;
      // Promise.resolve().then() normalises sync throws into rejections.
      const work = Promise.resolve().then(step);
      // An abandoned (timed out) step must not surface as an unhandled rejection.
      work.catch(() => undefined);
      try {
        if (timedOut) {
          await work;
        } else {
          await Promise.race([work, timeoutReached]);
        }
        if (timedOut) {
          failed = true;
        }
      } catch (error) {
        failed = true;
        log(`Shutdown step "${name}" failed`, error);
      }
    };

    await runStep("server.close", () => closeServer(deps.server));
    await runStep("pool.end", deps.closePool);
    await runStep("redis.disconnect", deps.disconnectRedis);
    await runStep("telemetry.shutdown", deps.shutdownTelemetry);

    clearTimeout(timer);

    const code = timedOut || failed ? 1 : 0;
    log(`Graceful shutdown finished with exit code ${code}`);
    exit(code);
  };
}

/**
 * Register the single shutdown owner on SIGTERM and SIGINT.
 * Signal handlers are never registered at import time; only this function
 * registers them. `uninstall` removes exactly those two listeners and is safe
 * to call more than once.
 */
export function installShutdownHandlers(deps: ShutdownDeps): {
  handler: (signal?: string) => Promise<void>;
  uninstall: () => void;
} {
  const handler = createShutdownHandler(deps);
  const log: LogFn = deps.log ?? defaultLog;

  const onSignal = (signal: NodeJS.Signals): void => {
    void handler(signal).catch((error: unknown) => {
      log(`Shutdown handler failed (signal: ${signal})`, error);
    });
  };

  const sigtermHandler = (): void => onSignal("SIGTERM");
  const sigintHandler = (): void => onSignal("SIGINT");

  process.on("SIGTERM", sigtermHandler);
  process.on("SIGINT", sigintHandler);

  let installed = true;
  const uninstall = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
  };

  return { handler, uninstall };
}
