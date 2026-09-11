import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { expect, it } from "vitest";
import { skipsSharedIpRateLimit } from "../../lib/rate-limit-policy.js";

it("isolates introspection from the browser bucket while enforcing both limits", async () => {
  const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 2,
    skip: req => skipsSharedIpRateLimit(req.path, req.method) }));
  app.post("/token/introspect", rateLimit({ windowMs: 60_000, limit: 3 }),
    (_req, res) => res.sendStatus(200));
  app.post("/sign-in/email", (_req, res) => res.sendStatus(200));
  for (let i = 0; i < 3; i++) {
    expect((await request(app).post("/token/introspect")).status).toBe(200);
  }
  expect((await request(app).post("/token/introspect")).status).toBe(429);
  expect((await request(app).post("/sign-in/email")).status).toBe(200);
  expect((await request(app).post("/sign-in/email")).status).toBe(200);
  expect((await request(app).post("/sign-in/email")).status).toBe(429);
});

for (const method of ["get", "put", "delete"] as const) {
  it(`keeps ${method} introspection requests in the general limiter`, async () => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, limit: 2,
      skip: req => skipsSharedIpRateLimit(req.path, req.method) }));
    for (let i = 0; i < 2; i++) {
      expect((await request(app)[method]("/token/introspect")).status).toBe(404);
    }
    expect((await request(app)[method]("/token/introspect")).status).toBe(429);
  });
}
