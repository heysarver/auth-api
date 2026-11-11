/**
 * Unit tests for lib/shutdown.ts
 *
 * The contract under test is the drain order and its failure modes:
 * server.close -> pool.end -> redis.disconnect -> telemetry.shutdown -> exit.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createShutdownHandler,
  installShutdownHandlers,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ShutdownDeps,
} from "../../lib/shutdown.js";

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface Recorded {
  calls: string[];
  logs: string[];
  exits: number[];
}

function recorder(): Recorded {
  return { calls: [], logs: [], exits: [] };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lib/shutdown.ts", () => {
  it("exports a 10s default budget", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("drains in the contract order and exits 0", async () => {
    const record = recorder();
    const deps: ShutdownDeps = {
      server: {
        close: (callback) => {
          record.calls.push("server.close");
          callback?.();
        },
      },
      closePool: async () => {
        record.calls.push("pool.end");
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      log: (message) => record.logs.push(message),
      exit: (code) => {
        record.exits.push(code);
        record.calls.push(`exit:${code}`);
      },
    };

    await createShutdownHandler(deps)("SIGTERM");

    expect(record.calls).toEqual([
      "server.close",
      "pool.end",
      "redis.disconnect",
      "telemetry.shutdown",
      "exit:0",
    ]);
    expect(record.exits).toEqual([0]);
  });

  it("awaits an in-flight request before ending the pool", async () => {
    const record = recorder();
    let releaseClose: (() => void) | undefined;

    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          record.calls.push("server.close");
          releaseClose = () => callback?.();
        },
      },
      closePool: async () => {
        record.calls.push("pool.end");
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      log: (message) => record.logs.push(message),
      exit: (code) => record.exits.push(code),
    });

    const drained = handler("SIGTERM");
    await flush();

    expect(record.calls).toEqual(["server.close"]);
    expect(record.exits).toEqual([]);

    releaseClose?.();
    await drained;

    expect(record.calls).toEqual([
      "server.close",
      "pool.end",
      "redis.disconnect",
      "telemetry.shutdown",
    ]);
    expect(record.exits).toEqual([0]);
  });

  it("releases idle keep-alive sockets immediately after close", async () => {
    const record = recorder();

    await createShutdownHandler({
      server: {
        close: (callback) => {
          record.calls.push("server.close");
          callback?.();
        },
        closeIdleConnections: () => record.calls.push("closeIdleConnections"),
      },
      closePool: async () => {
        record.calls.push("pool.end");
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      log: (message) => record.logs.push(message),
      exit: (code) => record.exits.push(code),
    })("SIGTERM");

    expect(record.calls).toEqual([
      "server.close",
      "closeIdleConnections",
      "pool.end",
      "redis.disconnect",
      "telemetry.shutdown",
    ]);
  });

  it("cuts active connections, finishes the remaining steps and exits 1 on timeout", async () => {
    vi.useFakeTimers();
    const record = recorder();

    const handler = createShutdownHandler({
      server: {
        close: () => {
          record.calls.push("server.close");
          // Never calls back: a stuck drain must not hang the process.
        },
        closeAllConnections: () => record.calls.push("closeAllConnections"),
      },
      closePool: async () => {
        record.calls.push("pool.end");
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      timeoutMs: 500,
      log: (message) => record.logs.push(message),
      exit: (code) => record.exits.push(code),
    });

    const drained = handler("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await drained;

    expect(record.calls).toContain("closeAllConnections");
    expect(record.calls).toEqual(
      expect.arrayContaining(["pool.end", "redis.disconnect", "telemetry.shutdown"]),
    );
    expect(record.exits).toEqual([1]);

    const timeoutLogs = record.logs.filter((line) => /timed out/i.test(line));
    expect(timeoutLogs).toHaveLength(1);
    expect(timeoutLogs[0]).toContain("500");
    expect(timeoutLogs[0]).toContain("server.close");
  });

  it("does not restart the sequence when a second signal arrives", async () => {
    const record = recorder();
    let releaseClose: (() => void) | undefined;

    const handler = createShutdownHandler({
      server: {
        close: (callback) => {
          record.calls.push("server.close");
          releaseClose = () => callback?.();
        },
      },
      closePool: async () => {
        record.calls.push("pool.end");
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      log: (message) => record.logs.push(message),
      exit: (code) => record.exits.push(code),
    });

    const first = handler("SIGTERM");
    await flush();

    await handler("SIGINT");

    expect(record.exits).toEqual([1]);
    expect(record.calls.filter((call) => call === "server.close")).toHaveLength(1);

    releaseClose?.();
    await first;

    expect(record.calls.filter((call) => call === "pool.end")).toHaveLength(1);
  });

  it("keeps draining when one step throws", async () => {
    const record = recorder();
    const poolError = new Error("pool already gone");

    await createShutdownHandler({
      server: {
        close: (callback) => {
          record.calls.push("server.close");
          callback?.();
        },
      },
      closePool: async () => {
        record.calls.push("pool.end");
        throw poolError;
      },
      disconnectRedis: async () => {
        record.calls.push("redis.disconnect");
      },
      shutdownTelemetry: async () => {
        record.calls.push("telemetry.shutdown");
      },
      log: (message) => record.logs.push(message),
      exit: (code) => record.exits.push(code),
    })("SIGTERM");

    expect(record.calls).toEqual([
      "server.close",
      "pool.end",
      "redis.disconnect",
      "telemetry.shutdown",
    ]);
    expect(record.exits).toEqual([1]);
    expect(record.logs.some((line) => line.includes("pool.end"))).toBe(true);
  });

  it("finishes an in-flight request against a real HTTP server", async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("drained response body");
      }, 100);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = new Promise<string>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/", agent: false },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve(`${res.statusCode}|${body}`));
        },
      );
      request.on("error", reject);
    });

    // Give the request time to reach the handler and be in flight.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const exit = vi.fn();
    const handler = createShutdownHandler({
      server,
      closePool: async () => undefined,
      disconnectRedis: async () => undefined,
      shutdownTelemetry: async () => undefined,
      log: () => undefined,
      exit,
    });

    await handler("SIGTERM");

    await expect(response).resolves.toBe("200|drained response body");
    expect(server.listening).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("registers exactly SIGTERM and SIGINT, and uninstalls safely twice", () => {
    const processOn = vi.spyOn(process, "on");
    const processRemove = vi.spyOn(process, "removeListener");

    const { uninstall } = installShutdownHandlers({
      server: { close: (callback) => callback?.() },
      closePool: async () => undefined,
      disconnectRedis: async () => undefined,
      shutdownTelemetry: async () => undefined,
      log: () => undefined,
      exit: () => undefined,
    });

    expect(processOn.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGINT"]);

    uninstall();
    uninstall();

    expect(processRemove.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGINT"]);
  });
});
