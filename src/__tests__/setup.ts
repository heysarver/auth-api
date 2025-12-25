/**
 * Test setup and global mocks
 * This file runs before all tests to configure the testing environment
 */

import { vi, afterAll } from "vitest";

// CRITICAL: Set NODE_ENV=test BEFORE importing instrumentation
// This prevents OpenTelemetry from initializing during tests
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test?schema=auth";
process.env.REDIS_URL = "redis://localhost:6379/15";
process.env.BETTER_AUTH_SECRET = "test-secret-key-minimum-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:3002";
process.env.FRONTEND_URL = "http://localhost:5173";
process.env.API_URL = "http://localhost:3001";
process.env.COOKIE_PREFIX = "test_auth";
process.env.SESSION_EXPIRES_IN = "86400";
process.env.SESSION_UPDATE_AGE = "3600";
process.env.APP_NAME = "TestApp";
process.env.PRODUCTION_DOMAIN = "test.com";
process.env.SUPPORT_EMAIL = "support@test.com";
process.env.TURNSTILE_ENABLED = "false"; // Disable Turnstile in tests by default
process.env.REQUIRE_EMAIL_VERIFICATION = "false"; // Disable email verification requirement in tests

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Mock PostgreSQL Pool
export const mockPoolQuery = vi.fn();
export const mockPoolEnd = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: mockPoolQuery,
    end: mockPoolEnd,
    connect: vi.fn(),
  })),
}));

// Mock Redis client
export const mockRedisGet = vi.fn();
export const mockRedisSet = vi.fn();
export const mockRedisDel = vi.fn();
export const mockRedisQuit = vi.fn();
export const mockRedisOn = vi.fn();

vi.mock("ioredis", () => {
  const MockRedis = vi.fn(function (this: any, _url: string, _options: any) {
    this.get = mockRedisGet;
    this.set = mockRedisSet;
    this.del = mockRedisDel;
    this.quit = mockRedisQuit;
    this.on = mockRedisOn;
    return this;
  });

  return {
    default: MockRedis,
  };
});

// Mock SendGrid
export const mockSendGridSend = vi.fn();
export const mockSendGridSetApiKey = vi.fn();

vi.mock("@sendgrid/mail", () => ({
  default: {
    send: mockSendGridSend,
    setApiKey: mockSendGridSetApiKey,
  },
}));

// Mock fetch for Turnstile API calls
global.fetch = vi.fn();

// Mock Better Auth
vi.mock("better-auth", () => ({
  betterAuth: vi.fn((config) => ({
    handler: vi.fn(),
    api: {
      getSession: vi.fn(),
      signUp: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    },
    $Infer: {
      Session: {},
    },
    ...config,
  })),
}));

vi.mock("better-auth/node", () => ({
  toNodeHandler: vi.fn((_auth) => (_req: any, _res: any, next: any) => {
    // Simple mock that calls next
    next();
  }),
}));

vi.mock("better-auth/plugins", () => ({
  jwt: vi.fn(() => ({})),
}));

// Mock OpenTelemetry SDK and instrumentations
// These mocks prevent actual telemetry initialization during tests
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn(() => ({
    start: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: vi.fn(() => []),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
  OTLPTraceExporter: vi.fn(() => ({
    export: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
  OTLPMetricExporter: vi.fn(() => ({
    export: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: vi.fn(() => ({
    shutdown: vi.fn(),
  })),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs) => ({ attributes: attrs })),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
  ATTR_SERVICE_VERSION: "service.version",
  // Note: ATTR_DEPLOYMENT_ENVIRONMENT doesn't exist in semantic-conventions
  // Use plain string "deployment.environment" instead
}));

// Reset all mocks before each test (but don't export this one)
// Tests will use their own beforeEach blocks

// Cleanup after all tests
afterAll(() => {
  vi.restoreAllMocks();
});

// Helper function to create a mock request
export function createMockRequest(options: {
  method?: string;
  path?: string;
  body?: any;
  headers?: Record<string, string>;
  ip?: string;
}) {
  return {
    method: options.method || "GET",
    path: options.path || "/",
    body: options.body || {},
    headers: options.headers || {},
    ip: options.ip || "127.0.0.1",
    socket: {
      remoteAddress: options.ip || "127.0.0.1",
    },
  };
}

// Helper function to create a mock response
export function createMockResponse() {
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  return res;
}

// Helper function to create a mock next function
export function createMockNext() {
  return vi.fn();
}
