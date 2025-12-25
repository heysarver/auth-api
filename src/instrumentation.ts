/**
 * OpenTelemetry instrumentation configuration
 *
 * This file MUST be imported BEFORE any other application code
 * to ensure auto-instrumentation captures all telemetry.
 *
 * Environment Variables:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP collector endpoint (e.g., http://alloy.lgtm.sarvent.cloud:4317)
 * - OTEL_SERVICE_NAME: Service name for traces/metrics/logs (e.g., auth-api)
 * - ENVIRONMENT: Deployment environment (e.g., development, staging, production)
 * - NODE_ENV: Node environment (development, test, production)
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

// Skip instrumentation in test environment to avoid interfering with mocks
if (process.env.NODE_ENV === "test") {
  console.log("Skipping OpenTelemetry instrumentation in test environment");
} else {
  // Configure resource attributes
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "auth-api",
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
    [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.ENVIRONMENT || process.env.NODE_ENV || "development",
  });

  // Configure OTLP exporters
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

  const traceExporter = new OTLPTraceExporter({
    url: otlpEndpoint,
  });

  const metricExporter = new OTLPMetricExporter({
    url: otlpEndpoint,
  });

  // Create periodic metric reader (exports every 60 seconds)
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000, // 1 minute
  });

  // Initialize the OpenTelemetry SDK
  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable specific instrumentations if needed
        // '@opentelemetry/instrumentation-fs': { enabled: false },

        // Configure HTTP instrumentation
        "@opentelemetry/instrumentation-http": {
          // Ignore health check endpoints to reduce noise
          ignoreIncomingRequestHook: (request) => {
            const url = request.url || "";
            return url === "/health" || url === "/";
          },
          // Add custom attributes to HTTP spans
          requestHook: (span, request) => {
            span.setAttribute("http.client_ip", request.socket?.remoteAddress || "unknown");
          },
        },

        // Configure Express instrumentation
        "@opentelemetry/instrumentation-express": {
          enabled: true,
        },

        // Configure PostgreSQL instrumentation
        "@opentelemetry/instrumentation-pg": {
          enabled: true,
          enhancedDatabaseReporting: true, // Include SQL statements in spans
        },

        // Configure Redis instrumentation
        "@opentelemetry/instrumentation-ioredis": {
          enabled: true,
        },
      }),
    ],
  });

  // Start the SDK
  sdk.start();
  console.log(`OpenTelemetry SDK initialized for ${process.env.OTEL_SERVICE_NAME || "auth-api"}`);
  console.log(`Exporting telemetry to: ${otlpEndpoint}`);

  // Gracefully shut down the SDK on process termination
  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log("OpenTelemetry SDK shut down successfully");
    } catch (error) {
      console.error("Error shutting down OpenTelemetry SDK:", error);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export default {};
