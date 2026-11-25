import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { isUnloggedPath, logSink, redactPath, setLogLevel, setLogSink } from '../src/lib/logger.ts';
import { app, newOrg } from './helpers.ts';

describe('health', () => {
  it('liveness and readiness', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ ok: true });
  });
});

describe('logging privacy', () => {
  const original = logSink;
  afterEach(() => {
    setLogSink(original);
    setLogLevel('error');
  });

  it('never logs anonymous-reporting traffic and redacts tokens', () => {
    expect(isUnloggedPath('/api/public/reports/orgs/acme/reports')).toBe(true);
    expect(isUnloggedPath('/r/acme')).toBe(true);
    expect(isUnloggedPath('/r/acme/status')).toBe(true);
    expect(isUnloggedPath('/reports')).toBe(false); // reviewer inbox is a normal, authenticated page
    expect(redactPath('/api/invitations/abc123/accept')).toBe('/api/invitations/:token/accept');
    expect(redactPath('/api/auth/password-reset/s3cr3t')).toBe('/api/auth/password-reset/:token');
    expect(redactPath('/api/auth/password-reset')).toBe('/api/auth/password-reset');
    expect(redactPath('/reset/s3cr3t')).toBe('/reset/:token');
  });

  it('access log: report routes leave no line; others are logged without query strings', async () => {
    const lines: string[] = [];
    const { slug, owner } = await newOrg();
    setLogSink((l) => lines.push(l));
    setLogLevel('debug');
    const logged = app;

    await request(logged)
      .post(`/api/public/reports/orgs/${slug}/reports`)
      .send({ category: 'Other', description: 'Something that must stay private.' });
    await owner.get('/api/auth/me?secret=1');
    await request(logged).get('/api/invitations/tok_abcdef');

    const all = lines.join('\n');
    expect(all).toContain('path=/api/auth/me');
    expect(all).toContain('/api/invitations/:token');
    expect(all).toMatch(/user=[0-9a-f-]{36}/);
    expect(all).not.toContain('public/reports');
    expect(all).not.toContain(slug);
    expect(all).not.toContain('secret=1');
    expect(all).not.toContain('tok_abcdef');
  });
});

describe('serving the built client', () => {
  function fakeBuild() {
    const dir = mkdtempSync(path.join(tmpdir(), 'synrgy-dist-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
    return createApp({ staticDir: dir });
  }

  it('serves assets with long caching and the app shell for client routes', async () => {
    const web = fakeBuild();
    const asset = await request(web).get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await request(web).get('/assets/missing.js')).status).toBe(404);

    const route = await request(web).get('/schedule').set('Accept', 'text/html');
    expect(route.status).toBe(200);
    expect(route.text).toContain('id="root"');
    expect(route.headers['cache-control']).toBe('no-cache');
    expect((await request(web).get('/r/acme').set('Accept', 'text/html')).text).toContain('id="root"');

    expect((await request(web).get('/sw.js')).headers['service-worker-allowed']).toBe('/');
    // The API keeps its JSON 404s.
    const api = await request(web).get('/api/nope').set('Accept', 'text/html');
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('not_found');
  });
});
