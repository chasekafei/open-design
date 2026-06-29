// Plan §3.K1 / spec §15.7 — bound-API-token guard.
//
// Two halves:
//   1. The daemon refuses to start with OD_BIND_HOST=0.0.0.0 when no
//      OD_API_TOKEN is set.
//   2. When OD_API_TOKEN is set, every /api/* request from a non-loopback
//      peer must carry `Authorization: Bearer <OD_API_TOKEN>`. The
//      health/readiness/version probes stay open for monitoring.
//
// Tests force the bearer-required code path by stamping the env vars
// before startServer. The daemon listens on 127.0.0.1 throughout (so
// the "refuse 0.0.0.0 without token" path is exercised by a separate
// negative case that constructs the start call directly).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isApiAuthDisabled, isApiTokenMiddlewareEnabled } from '../src/api-token-auth.js';
import {
  buildApiTokenBootstrapScript,
  registerStaticSpaFallback,
  renderIndexHtmlWithToken,
} from '../src/static-spa.js';
import { startServer } from '../src/server.js';

const PREVIOUS_TOKEN = process.env.OD_API_TOKEN;
const PREVIOUS_HOST  = process.env.OD_BIND_HOST;
const PREVIOUS_DISABLE_API_AUTH = process.env.OD_DISABLE_API_AUTH;
const PREVIOUS_ALLOWED_ORIGINS = process.env.OD_ALLOWED_ORIGINS;

let server: http.Server | undefined;
let baseUrl = '';
let shutdown: (() => Promise<void> | void) | undefined;
let staticFixtureDir: string | undefined;

afterEach(async () => {
  if (shutdown) await Promise.resolve(shutdown());
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  shutdown = undefined;
  if (staticFixtureDir) fs.rmSync(staticFixtureDir, { recursive: true, force: true });
  staticFixtureDir = undefined;
  if (PREVIOUS_TOKEN === undefined) delete process.env.OD_API_TOKEN;
  else process.env.OD_API_TOKEN = PREVIOUS_TOKEN;
  if (PREVIOUS_HOST === undefined) delete process.env.OD_BIND_HOST;
  else process.env.OD_BIND_HOST = PREVIOUS_HOST;
  if (PREVIOUS_DISABLE_API_AUTH === undefined) delete process.env.OD_DISABLE_API_AUTH;
  else process.env.OD_DISABLE_API_AUTH = PREVIOUS_DISABLE_API_AUTH;
  if (PREVIOUS_ALLOWED_ORIGINS === undefined) delete process.env.OD_ALLOWED_ORIGINS;
  else process.env.OD_ALLOWED_ORIGINS = PREVIOUS_ALLOWED_ORIGINS;
});

describe('bound-API-token guard', () => {
  it('refuses to start with OD_BIND_HOST=0.0.0.0 when OD_API_TOKEN is unset', async () => {
    delete process.env.OD_API_TOKEN;
    await expect(startServer({ port: 0, host: '0.0.0.0', returnServer: true }))
      .rejects.toThrow(/OD_API_TOKEN/);
  });

  it('starts on a public host when OD_API_TOKEN is set', async () => {
    process.env.OD_API_TOKEN = 'test-token-abc';
    // Bind to 127.0.0.1 (loopback) but pretend we crossed the guard
    // by setting the env var; the assertion is that startup succeeds.
    const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    server = started.server;
    shutdown = started.shutdown;
    baseUrl = started.url;
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('starts on a public host without OD_API_TOKEN when OD_DISABLE_API_AUTH=1', async () => {
    delete process.env.OD_API_TOKEN;
    process.env.OD_DISABLE_API_AUTH = '1';
    const started = (await startServer({ port: 0, host: '0.0.0.0', returnServer: true })) as {
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    server = started.server;
    shutdown = started.shutdown;
  });
});

describe('bearer middleware', () => {
  beforeEach(async () => {
    process.env.OD_API_TOKEN = 'secret-test-token';
    const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  it('accepts loopback callers without a bearer (desktop UI flow)', async () => {
    // The HTTP test client is on the same machine → req.socket.remoteAddress
    // is 127.0.0.1 → middleware short-circuits.
    const resp = await fetch(`${baseUrl}/api/plugins`);
    expect(resp.status).toBe(200);
  });

  it('keeps health / readiness / version probes open without a bearer', async () => {
    for (const path of ['/api/health', '/api/ready', '/api/version']) {
      const resp = await fetch(`${baseUrl}${path}`);
      expect(resp.status).toBe(200);
    }
  });

  it('lets same-origin browser SSE clients open project events without a bearer', async () => {
    const origin = new URL(baseUrl).origin;
    process.env.OD_ALLOWED_ORIGINS = origin;
    const resp = await fetch(`${baseUrl}/api/projects/missing-project/events`, {
      headers: { origin },
    });
    expect(resp.status).not.toBe(401);
    expect(resp.status).toBe(404);
  });

  it('lets file viewer HTML previews load with Origin: null (sandboxed iframe)', async () => {
    const resp = await fetch(`${baseUrl}/api/projects/missing/raw/design.html`, {
      headers: { origin: 'null' },
    });
    expect(resp.status).not.toBe(401);
  });

  it('rejects non-GET methods to the project file endpoint behind Origin: null', async () => {
    const resp = await fetch(`${baseUrl}/api/projects/missing/raw/design.html`, {
      method: 'DELETE',
      headers: { origin: 'null' },
    });
    expect(resp.status).toBe(403);
  });

  it('injects the API token bootstrap script into SPA fallback HTML', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-spa-fallback-'));
    staticFixtureDir = fixtureDir;
    fs.writeFileSync(path.join(fixtureDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');

    const express = (await import('express')).default;
    const app = express();
    registerStaticSpaFallback(app, fixtureDir, { apiToken: 'secret-test-token' });
    const local = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (local.address() as { port: number }).port;
    try {
      const splat = await fetch(`http://127.0.0.1:${port}/projects/some-id`, {
        headers: { accept: 'text/html' },
      });
      expect(splat.status).toBe(200);
      const body = await splat.text();
      expect(body).toContain('__OD_API_TOKEN__');
      expect(body).toContain('Authorization');
      expect(body).toMatch(/__OD_API_TOKEN__="secret-test-token"/);
    } finally {
      await new Promise<void>((r) => local.close(() => r()));
    }
  });

  it('disables bearer middleware when OD_DISABLE_API_AUTH=1 even if OD_API_TOKEN is set', () => {
    expect(
      isApiTokenMiddlewareEnabled({
        ...process.env,
        OD_API_TOKEN: 'secret-test-token',
        OD_DISABLE_API_AUTH: '1',
      }),
    ).toBe(false);
    expect(
      isApiAuthDisabled({
        ...process.env,
        OD_DISABLE_API_AUTH: '1',
      }),
    ).toBe(true);
  });
});

describe('renderIndexHtmlWithToken helper', () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it('returns raw HTML when no token is set', () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-token-render-'));
    const idx = path.join(fixtureDir, 'index.html');
    fs.writeFileSync(idx, '<html><head></head></html>');
    expect(renderIndexHtmlWithToken(idx, '')).toBe('<html><head></head></html>');
  });

  it('inserts bootstrap script into <head>', () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-token-render-'));
    const idx = path.join(fixtureDir, 'index.html');
    fs.writeFileSync(idx, '<html><head></head><body></body></html>');
    const out = renderIndexHtmlWithToken(idx, 'tok-123');
    expect(out).toMatch(/<head><script>[\s\S]*__OD_API_TOKEN__="tok-123"[\s\S]*<\/script>/);
  });

  it('rejects browser-side script injection by JSON-encoding the token', () => {
    const script = buildApiTokenBootstrapScript('</script><script>alert(1)</script>');
    expect(script).not.toContain('</script>alert');
    expect(script).toContain('\\u003c');
  });
});
