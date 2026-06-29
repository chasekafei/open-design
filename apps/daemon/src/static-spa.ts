import type { Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export interface StaticSpaFallbackRequestLike {
  method: string;
  path: string;
  get?: (name: string) => string | undefined;
}

export interface RegisterStaticSpaFallbackOptions {
  apiToken?: string;
}

export function isStaticSpaFallbackRequest(req: StaticSpaFallbackRequestLike): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.path === '/api' || req.path.startsWith('/api/')) return false;
  if (req.path === '/artifacts' || req.path.startsWith('/artifacts/')) return false;
  if (req.path === '/frames' || req.path.startsWith('/frames/')) return false;
  if (req.path === '/_next' || req.path.startsWith('/_next/')) return false;

  const accept = req.get?.('accept') ?? '';
  return accept.length === 0 || accept.includes('text/html') || accept.includes('*/*');
}

export function resolveStaticSpaFallbackPath(req: StaticSpaFallbackRequestLike, staticDir: string): string | null {
  const indexPath = path.join(staticDir, 'index.html');
  if (!fs.existsSync(indexPath) || !isStaticSpaFallbackRequest(req)) return null;
  return indexPath;
}

// Loader script injected into index.html so the web UI can include the
// daemon API token in same-origin /api/* fetch calls.  This is
// load-bearing for reverse-proxy deployments (Railway, Fly.io, etc.)
// where the browser is not on loopback and the bearer middleware would
// otherwise reject every API call from the web UI.  The wrapper reads
// the token from `window.__OD_API_TOKEN__` so a stale script tag in a
// cached HTML page still works.
export function buildApiTokenBootstrapScript(apiToken: string): string {
  // JSON.stringify leaves `<` and `>` unescaped, which lets a token
  // containing `</script>` terminate the surrounding <script> early
  // and execute attacker-controlled HTML.  Re-encode the angle brackets
  // after stringifying so the script body stays inert.
  const safeToken = JSON.stringify(apiToken).replace(/</g, '\\u003c');
  return [
    '<script>',
    `window.__OD_API_TOKEN__=${safeToken};`,
    '(function(){',
    'var t=window.__OD_API_TOKEN__,f=window.fetch;',
    'window.fetch=function(i,o){',
    'o=o||{};var h=new Headers(o.headers||{});',
    'var u=typeof i==="string"?i:i.url;',
    // Request.url is the fully-resolved URL (includes origin).  Strip
    // the origin so startsWith("/api/") matches both relative and
    // absolute same-origin URLs.
    'u=u?u.replace(/^https?:\\/\\/[^/]+/,""):"";',
    'if(u.startsWith("/api/")&&!h.has("Authorization")){',
    'h.set("Authorization","Bearer "+t);',
    '}',
    'o.headers=h;return f.call(this,i,o);',
    '};',
    '})();',
    '</script>',
  ].join('');
}

export function renderIndexHtmlWithToken(indexPath: string, apiToken: string): string {
  const raw = fs.readFileSync(indexPath, 'utf-8');
  if (!apiToken) return raw;
  return raw.replace('<head>', `<head>${buildApiTokenBootstrapScript(apiToken)}`);
}

export function registerStaticSpaFallback(
  app: Express,
  staticDir: string,
  options?: RegisterStaticSpaFallbackOptions,
): void {
  const apiToken = (options?.apiToken ?? '').trim();
  app.get('/*splat', (req, res, next) => {
    const indexPath = resolveStaticSpaFallbackPath(req, staticDir);
    if (indexPath == null) return next();
    try {
      const html = renderIndexHtmlWithToken(indexPath, apiToken);
      res.type('html').send(html);
    } catch {
      next();
    }
  });
}
