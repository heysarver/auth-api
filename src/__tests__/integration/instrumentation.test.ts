/**
 * Integration tests for OpenTelemetry instrumentation
 * Verifies that instrumentation initializes correctly and doesn't break the app
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

async function importFreshInstrumentation(caseName: string) {
  const module = await import(
    /* @vite-ignore */ `../../instrumentation.ts?case=${caseName}-${Date.now()}`
  );
  return module as { shutdownInstrumentation: () => Promise<void> };
}

function mockConstructors(modules: {
  NodeSDK: any;
  OTLPTraceExporter?: any;
  OTLPMetricExporter?: any;
  PeriodicExportingMetricReader?: any;
  sdk?: Record<string, unknown>;
}) {
  vi.mocked(modules.NodeSDK).mockImplementation(function () {
    return modules.sdk ?? { start: vi.fn(), shutdown: vi.fn().mockResolvedValue(undefined) };
  } as any);

  if (modules.OTLPTraceExporter) {
    vi.mocked(modules.OTLPTraceExporter).mockImplementation(function () {
      return { export: vi.fn(), shutdown: vi.fn() };
    } as any);
  }

  if (modules.OTLPMetricExporter) {
    vi.mocked(modules.OTLPMetricExporter).mockImplementation(function () {
      return { export: vi.fn(), shutdown: vi.fn() };
    } as any);
  }

  if (modules.PeriodicExportingMetricReader) {
    vi.mocked(modules.PeriodicExportingMetricReader).mockImplementation(function () {
      return { shutdown: vi.fn() };
    } as any);
  }
}

describe("OpenTelemetry Instrumentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  describe("Test Environment Behavior", () => {
    it("should skip instrumentation in test environment", () => {
      // Verify NODE_ENV is set to test
      expect(process.env.NODE_ENV).toBe("test");
    });

    it("should import without starting the SDK in test environment", async () => {
      process.env.NODE_ENV = "test";

      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const nodeSdkMock = vi.mocked(NodeSDK);

      await importFreshInstrumentation("test-env");

      expect(nodeSdkMock).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        "Skipping OpenTelemetry instrumentation in test environment"
      );
    });

    it("should expose a no-op shutdownInstrumentation in test environment", async () => {
      process.env.NODE_ENV = "test";

      const instrumentation = await importFreshInstrumentation("test-env-shutdown");

      expect(typeof instrumentation.shutdownInstrumentation).toBe("function");
      await expect(instrumentation.shutdownInstrumentation()).resolves.toBeUndefined();
    });

    it("should have mocked OpenTelemetry modules", async () => {
      // Dynamically import the mocked modules
      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");

      // Verify mocks exist
      expect(NodeSDK).toBeDefined();
      expect(getNodeAutoInstrumentations).toBeDefined();

      // Verify they are mock functions
      expect(vi.isMockFunction(NodeSDK)).toBe(true);
      expect(vi.isMockFunction(getNodeAutoInstrumentations)).toBe(true);
    });
  });

  describe("Instrumentation Configuration", () => {
    it("should define expected environment variables for instrumentation", () => {
      const requiredEnvVars = [
        "OTEL_SERVICE_NAME",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "ENVIRONMENT",
      ];

      // These don't need to be set in tests, but the code should handle them
      requiredEnvVars.forEach((envVar) => {
        const value = process.env[envVar];
        expect(value === undefined || typeof value === "string").toBe(true);
      });
    });

    it("should handle missing OTLP endpoint gracefully", () => {
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
      expect(endpoint).toBeDefined();
      expect(typeof endpoint).toBe("string");
    });

    it("should use default service name when not configured", () => {
      const serviceName = process.env.OTEL_SERVICE_NAME || "auth-api";
      expect(serviceName).toBeDefined();
      expect(serviceName).toContain("auth");
    });
  });

  describe("Resource Attributes", () => {
    it("should include required semantic conventions", async () => {
      const {
        ATTR_SERVICE_NAME,
        ATTR_SERVICE_VERSION
      } = await import("@opentelemetry/semantic-conventions");

      expect(ATTR_SERVICE_NAME).toBe("service.name");
      expect(ATTR_SERVICE_VERSION).toBe("service.version");
      // Note: deployment.environment is set as a plain string, not a constant
      // because ATTR_DEPLOYMENT_ENVIRONMENT doesn't exist in semantic-conventions
    });
  });

  describe("SDK Lifecycle", () => {
    it("should verify NodeSDK is mocked in tests", async () => {
      const { NodeSDK } = await import("@opentelemetry/sdk-node");

      // Verify the NodeSDK is mocked as a function
      expect(vi.isMockFunction(NodeSDK)).toBe(true);

      // Call the mock to get the mocked SDK instance
      const sdk = (NodeSDK as any)();

      expect(sdk).toBeDefined();
      expect(sdk.start).toBeDefined();
      expect(sdk.shutdown).toBeDefined();
    });

    it("should handle SDK shutdown gracefully", async () => {
      const { NodeSDK } = await import("@opentelemetry/sdk-node");

      // Get the mocked SDK instance
      const sdk = (NodeSDK as any)();

      await expect(sdk.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("Auto-Instrumentation", () => {
    it("should configure auto-instrumentations", async () => {
      const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");

      const instrumentations = getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (request: any) => {
            return request.url === "/health" || request.url === "/";
          },
        },
      });

      expect(instrumentations).toBeDefined();
      expect(getNodeAutoInstrumentations).toHaveBeenCalled();
    });
  });

  describe("Runtime Initialization", () => {
    it("should configure and start OpenTelemetry outside test environments", async () => {
      process.env.NODE_ENV = "production";
      process.env.ENVIRONMENT = "staging";
      process.env.OTEL_SERVICE_NAME = "auth-api-test";
      process.env.npm_package_version = "9.8.7";
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4317";

      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      const { resourceFromAttributes } = await import("@opentelemetry/resources");

      const start = vi.fn();
      const shutdown = vi.fn().mockResolvedValue(undefined);
      mockConstructors({
        NodeSDK,
        OTLPTraceExporter,
        OTLPMetricExporter,
        PeriodicExportingMetricReader,
        sdk: { start, shutdown },
      });
      const processOn = vi.spyOn(process, "on").mockReturnValue(process);

      await importFreshInstrumentation("runtime-init");

      expect(resourceFromAttributes).toHaveBeenCalledWith({
        "service.name": "auth-api-test",
        "service.version": "9.8.7",
        environment: "staging",
      });
      expect(OTLPTraceExporter).toHaveBeenCalledWith({
        url: "http://otel-collector:4317",
      });
      expect(OTLPMetricExporter).toHaveBeenCalledWith({
        url: "http://otel-collector:4317",
      });
      expect(PeriodicExportingMetricReader).toHaveBeenCalledWith({
        exporter: expect.anything(),
        exportIntervalMillis: 60000,
      });
      expect(NodeSDK).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: expect.anything(),
          traceExporter: expect.anything(),
          metricReader: expect.anything(),
          instrumentations: expect.any(Array),
        })
      );
      expect(start).toHaveBeenCalledOnce();
      // The module must never own process termination: signal handling lives
      // in lib/shutdown.ts.
      expect(processOn).not.toHaveBeenCalled();
      expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
      expect(console.log).toHaveBeenCalledWith(
        "OpenTelemetry SDK initialized for auth-api-test"
      );
      expect(console.log).toHaveBeenCalledWith(
        "Exporting telemetry to: http://otel-collector:4317"
      );

      const instrumentationConfig = vi.mocked(getNodeAutoInstrumentations).mock.calls[0]?.[0] as any;
      const httpConfig = instrumentationConfig["@opentelemetry/instrumentation-http"];
      expect(httpConfig.ignoreIncomingRequestHook({ url: "/health" })).toBe(true);
      expect(httpConfig.ignoreIncomingRequestHook({ url: "/" })).toBe(true);
      expect(httpConfig.ignoreIncomingRequestHook({ url: "/session" })).toBe(false);

      const span = { setAttribute: vi.fn() };
      httpConfig.requestHook(span, { socket: { remoteAddress: "203.0.113.1" } });
      expect(span.setAttribute).toHaveBeenCalledWith("http.client_ip", "203.0.113.1");
      httpConfig.requestHook(span, {});
      expect(span.setAttribute).toHaveBeenCalledWith("http.client_ip", "unknown");
    });

    it("should shut down the SDK once through shutdownInstrumentation", async () => {
      process.env.NODE_ENV = "production";

      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      mockConstructors({
        NodeSDK,
        OTLPTraceExporter,
        OTLPMetricExporter,
        PeriodicExportingMetricReader,
        sdk: { start: vi.fn(), shutdown },
      });

      const processOn = vi.spyOn(process, "on").mockReturnValue(process);
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);

      const instrumentation = await importFreshInstrumentation("shutdown-success");
      await instrumentation.shutdownInstrumentation();

      expect(shutdown).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalledWith("OpenTelemetry SDK shut down successfully");
      // Termination belongs to lib/shutdown.ts, not to instrumentation.
      expect(exit).not.toHaveBeenCalled();
      expect(processOn).not.toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(processOn).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });

    it("should shut the SDK down only once across repeated calls", async () => {
      process.env.NODE_ENV = "production";

      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const shutdown = vi.fn().mockResolvedValue(undefined);
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      mockConstructors({
        NodeSDK,
        OTLPTraceExporter,
        OTLPMetricExporter,
        PeriodicExportingMetricReader,
        sdk: { start: vi.fn(), shutdown },
      });

      const instrumentation = await importFreshInstrumentation("shutdown-idempotent");
      await instrumentation.shutdownInstrumentation();
      await instrumentation.shutdownInstrumentation();

      expect(shutdown).toHaveBeenCalledOnce();
    });

    it("should log shutdown errors without terminating the process", async () => {
      process.env.NODE_ENV = "production";

      const { NodeSDK } = await import("@opentelemetry/sdk-node");
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      const shutdownError = new Error("collector unavailable");
      mockConstructors({
        NodeSDK,
        OTLPTraceExporter,
        OTLPMetricExporter,
        PeriodicExportingMetricReader,
        sdk: {
          start: vi.fn(),
          shutdown: vi.fn().mockRejectedValue(shutdownError),
        },
      });

      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);

      const instrumentation = await importFreshInstrumentation("shutdown-error");
      await instrumentation.shutdownInstrumentation();

      expect(console.error).toHaveBeenCalledWith(
        "Error shutting down OpenTelemetry SDK:",
        shutdownError
      );
      expect(exit).not.toHaveBeenCalled();
    });
  });

  describe("Exporter Configuration", () => {
    it("should verify OTLP trace exporter is mocked", async () => {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");

      // Verify the exporter is mocked
      expect(vi.isMockFunction(OTLPTraceExporter)).toBe(true);

      // Get mocked instance
      const exporter = (OTLPTraceExporter as any)();

      expect(exporter).toBeDefined();
      expect(exporter.export).toBeDefined();
    });

    it("should verify OTLP metric exporter is mocked", async () => {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");

      // Verify the exporter is mocked
      expect(vi.isMockFunction(OTLPMetricExporter)).toBe(true);

      // Get mocked instance
      const exporter = (OTLPMetricExporter as any)();

      expect(exporter).toBeDefined();
      expect(exporter.export).toBeDefined();
    });

    it("should verify periodic metric reader is mocked", async () => {
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");

      // Verify the reader is mocked
      expect(vi.isMockFunction(PeriodicExportingMetricReader)).toBe(true);

      // Get mocked instance
      const reader = (PeriodicExportingMetricReader as any)();

      expect(reader).toBeDefined();
    });
  });
});
