# OpenTelemetry Instrumentation

This service is instrumented with OpenTelemetry for comprehensive observability.

## Configuration

OpenTelemetry is configured via environment variables:

### Required Environment Variables

```bash
# OpenTelemetry Exporter Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.lgtm.sarvent.cloud:4317

# Service Identification
OTEL_SERVICE_NAME=auth-api
ENVIRONMENT=production
```

### Optional Environment Variables

```bash
# Service version (defaults to package.json version)
npm_package_version=1.0.0
```

## What is Instrumented

The service automatically instruments:

1. **HTTP/HTTPS Requests** - All incoming and outgoing HTTP requests
2. **Express Framework** - Routes, middleware, and handlers
3. **PostgreSQL** - Database queries with enhanced reporting (SQL statements included)
4. **Redis/IORedis** - All Redis operations
5. **Custom Metrics** - Application-specific metrics can be added

## Excluded from Instrumentation

The following endpoints are excluded from tracing to reduce noise:
- `/health` - Health check endpoint
- `/` - Root endpoint

## How It Works

### Development Mode

When running `npm run dev`, the instrumentation file is loaded automatically before the application starts:

```bash
tsx --import ./src/instrumentation.ts src/index.ts
```

### Production Mode

When running `npm start` after `npm run build`, the compiled instrumentation is loaded:

```bash
node --import ./dist/instrumentation.js dist/index.js
```

### Test Mode

In test environments (`NODE_ENV=test`), OpenTelemetry instrumentation is **automatically skipped** to avoid interfering with test mocks.

## Telemetry Data Exported

### Traces

- **Endpoint**: OTLP/gRPC at configured `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Format**: OTLP (OpenTelemetry Protocol)
- **Includes**:
  - HTTP request/response details
  - Database query execution
  - Redis commands
  - Service-to-service calls

### Metrics

- **Endpoint**: OTLP/gRPC at configured `OTEL_EXPORTER_OTLP_ENDPOINT`
- **Export Interval**: 60 seconds
- **Format**: OTLP (OpenTelemetry Protocol)
- **Includes**:
  - HTTP request counts and durations
  - Database connection pool metrics
  - Redis operation metrics
  - System resource usage

### Resource Attributes

All telemetry includes these resource attributes:

- `service.name` - Service identifier (from `OTEL_SERVICE_NAME`)
- `service.version` - Application version (from `npm_package_version`)
- `deployment.environment` - Environment identifier (from `ENVIRONMENT` or `NODE_ENV`)

## Custom Instrumentation

To add custom spans or metrics, import the OpenTelemetry API:

```typescript
import { trace, metrics } from "@opentelemetry/api";

// Custom span
const tracer = trace.getTracer("my-custom-tracer");
const span = tracer.startSpan("my-operation");
try {
  // Your code here
  span.addEvent("Processing started");
  // More code
  span.setStatus({ code: SpanStatusCode.OK });
} finally {
  span.end();
}

// Custom metric
const meter = metrics.getMeter("my-custom-meter");
const counter = meter.createCounter("my_custom_counter");
counter.add(1, { "custom.attribute": "value" });
```

## Viewing Telemetry

Telemetry is exported to the LGTM stack:

- **Traces**: Tempo at `tempo.lgtm.sarvent.cloud`
- **Metrics**: Mimir at `mimir.lgtm.sarvent.cloud`
- **Dashboards**: Grafana at `grafana.lgtm.sarvent.cloud`

## Troubleshooting

### Instrumentation Not Working

1. **Check environment variables**:
   ```bash
   echo $OTEL_EXPORTER_OTLP_ENDPOINT
   echo $OTEL_SERVICE_NAME
   ```

2. **Check startup logs**:
   ```
   OpenTelemetry SDK initialized for auth-api
   Exporting telemetry to: http://alloy.lgtm.sarvent.cloud:4317
   ```

3. **Verify NODE_ENV is not "test"**:
   Instrumentation is disabled in test mode.

### No Telemetry Data in Backend

1. **Check network connectivity** to `alloy.lgtm.sarvent.cloud:4317`
2. **Verify the OTLP endpoint is accepting data** (gRPC on port 4317)
3. **Check application logs** for export errors

### Performance Impact

OpenTelemetry instrumentation has minimal performance impact:
- **Traces**: ~1-3% overhead on instrumented operations
- **Metrics**: Exported every 60 seconds (batched)
- **Memory**: ~10-20MB additional memory usage

To reduce overhead, you can disable specific instrumentations by modifying `src/instrumentation.ts`.

## References

- [OpenTelemetry JavaScript Documentation](https://opentelemetry.io/docs/languages/js/)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)
- [Auto-Instrumentations for Node.js](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node)
