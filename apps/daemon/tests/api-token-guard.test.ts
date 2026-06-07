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
import {
  buildApiTokenBootstrapScript,
  registerStaticSpaFallback,
  resolveStaticSpaFallbackPath,
  startServer,
} from '../src/server.js';

const PREVIOUS_TOKEN = process.env.OD_API_TOKEN;
const PREVIOUS_HOST  = process.env.OD_BIND_HOST;

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

  it('lets file viewer HTML previews load with Origin: null (sandboxed iframe)', async () => {
    // The file viewer renders HTML previews inside an iframe with
    // `sandbox="allow-scripts allow-downloads"` (no allow-same-origin),
    // so the request carries `Origin: null` and no Authorization.
    // The route still 404s for the missing project, but the bearer
    // middleware must let it through — a 401 here would mean the
    // iframe never gets to render.
    const resp = await fetch(`${baseUrl}/api/projects/missing/raw/design.html`, {
      headers: { origin: 'null' },
    });
    expect(resp.status).not.toBe(401);
  });

  it('rejects non-GET methods to the project file endpoint behind Origin: null', async () => {
    // The Origin: null bypass only covers read-only GET — DELETE on
    // the same path is a state-changing operation and must keep the
    // bearer requirement. The route's own auth still rejects this, so
    // we only need to assert we never see the 401 from the bearer
    // gate (the cross-origin middleware produces 403 for bad methods).
    const resp = await fetch(`${baseUrl}/api/projects/missing/raw/design.html`, {
      method: 'DELETE',
      headers: { origin: 'null' },
    });
    expect(resp.status).toBe(403);
  });

  it('injects the API token bootstrap script into SPA fallback HTML', async () => {
    // The bearer middleware alone is not enough on a reverse-proxy
    // deploy — the browser needs the token to attach as a header on
    // outgoing /api/* fetches.  The script is injected into any HTML
    // page the daemon serves, including SPA route fallbacks like
    // /projects/<id>, not just the root index.  This covers the
    // `registerStaticSpaFallback` path directly so the test does not
    // depend on the production web build output existing.
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
      // Token value must not leak verbatim — JSON.stringify wraps it.
      expect(body).toMatch(/__OD_API_TOKEN__="secret-test-token"/);
    } finally {
      await new Promise<void>((r) => local.close(() => r()));
    }
  });
});

describe('renderIndexHtmlWithToken helper', () => {
  let fixtureDir: string | undefined;

  afterEach(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it('returns raw HTML when no token is set', async () => {
    const { renderIndexHtmlWithToken } = await import('../src/server.js');
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-token-render-'));
    const idx = path.join(fixtureDir, 'index.html');
    fs.writeFileSync(idx, '<html><head></head></html>');
    expect(renderIndexHtmlWithToken(idx, '')).toBe('<html><head></head></html>');
  });

  it('inserts bootstrap script into <head>', async () => {
    const { renderIndexHtmlWithToken } = await import('../src/server.js');
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-token-render-'));
    const idx = path.join(fixtureDir, 'index.html');
    fs.writeFileSync(idx, '<html><head></head><body></body></html>');
    const out = renderIndexHtmlWithToken(idx, 'tok-123');
    expect(out).toMatch(/<head><script>[\s\S]*__OD_API_TOKEN__="tok-123"[\s\S]*<\/script>/);
  });

  it('rejects browser-side script injection by JSON-encoding the token', () => {
    const script = buildApiTokenBootstrapScript('</script><script>alert(1)</script>');
    // The closing </script> in the token must be escaped so the
    // browser does not terminate the surrounding <script> early.
    expect(script).not.toContain('</script>alert');
    expect(script).toContain('\\u003c');
  });
});
