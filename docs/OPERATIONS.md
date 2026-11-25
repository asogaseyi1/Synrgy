# Running Synrgy in production

This guide covers deploying, configuring, monitoring and backing up a Synrgy instance.
One container serves both the API and the web app; it needs a PostgreSQL 15+ database.

## 1. Deploy

```sh
docker build -t synrgy .
docker run -d --name synrgy -p 4000:4000 \
  -e DATABASE_URL=postgres://synrgy:•••@db.internal:5432/synrgy \
  -e CLIENT_ORIGIN=https://hr.example.com \
  -e MAIL_PROVIDER=resend -e RESEND_API_KEY=re_••• -e MAIL_FROM="Acme HR <hr@acme.example>" \
  synrgy
```

- **Migrations** run automatically at start-up (`MIGRATE_ON_START=true` in the image). They take a Postgres
  advisory lock, so several instances starting together is safe. To run them as a separate release step instead,
  set `MIGRATE_ON_START=false` and run `node server/src/migrate-cli.ts` in the container.
- **TLS** is expected to terminate at a reverse proxy or load balancer in front of the container. The app sets
  `Secure` cookies, HSTS and `upgrade-insecure-requests` when `HTTPS` is on (the production default).
  It trusts one proxy hop for `X-Forwarded-*` (`trust proxy = 1`).
- **Shutdown**: on `SIGTERM` the server stops accepting connections, finishes in-flight requests and queued
  email (up to 10 s), then exits.
- Try the production image locally: `docker compose --profile app up --build`, then open http://localhost:8080.

### Single instance vs. several

Rate limits are kept in memory per process. With more than one instance, limits apply per instance
(still useful, but weaker); move them to a shared store before scaling out. The daily report digest is
safe with several instances (each day's run is claimed in the `job_runs` table).

## 2. Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | – | **Required.** Use a role that owns the schema (migrations create tables). |
| `CLIENT_ORIGIN` | `http://localhost:5173` | The public URL of the app. Allowed as a request origin. |
| `APP_URL` | `CLIENT_ORIGIN` | Base URL for links in emails. |
| `ALLOWED_ORIGINS` | – | Extra origins allowed to make changes (comma-separated). |
| `HTTPS` | `true` in production | `false` only for local try-outs over plain HTTP. |
| `PORT` | `4000` | |
| `MAIL_PROVIDER` | `none` in production | `resend`, `webhook`, `console` (logs email bodies; dev only) or `none`. |
| `MAIL_FROM`, `RESEND_API_KEY`, `MAIL_WEBHOOK_URL` | – | Provider settings. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | `json` in production | `pretty` for humans. |
| `SESSION_TTL_DAYS` | `7` | |
| `PASSWORD_RESET_TTL_MINUTES` | `60` | |
| `RATE_LIMITS` | `on` | Never turn off in production. |
| `BCRYPT_ROUNDS` | `12` | |

Everything company-specific (time zone, week start, pay rules, swap approval, report categories, departments and
locations) is set by each workspace's admins in **Settings**, not in environment variables.

## 3. Health checks

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/health` | The process is running. | Liveness probe. |
| `GET /api/health/ready` | The database answers and every migration is applied (`503` otherwise, with a reason). | Readiness probe, load balancer health check. |

The Docker image's `HEALTHCHECK` calls the readiness endpoint. Neither endpoint appears in the access log.

## 4. Logs

Logs are JSON lines on stdout/stderr (one object per line: `time`, `level`, `msg`, plus fields), ready for any log
collector. Each request gets an `X-Request-Id` (or keeps a valid incoming one); it is in the response header and
in every log line for that request, so a user-reported error can be matched to its log entry.

What is **never** logged, by design:

- **Anonymous reporting traffic.** Requests to `/api/public/reports/*` and the `/r/*` pages produce no log
  line at all, and errors on those routes log only an error code.
- Query strings, request bodies, cookies, IP addresses and user agents.
- Invite and password-reset tokens in URLs (replaced with `:token`).
- Postgres error details (they can echo row values); only the error code is logged.

### Your proxy must not undo this

The app can only control its own logs. A reverse proxy, CDN or load balancer in front of it usually keeps its own
access log, with IP addresses and exact times, which could identify an anonymous reporter. **Turn off access
logging for `/r/` and `/api/public/reports/`** at that layer:

```nginx
# nginx
location ~ ^/(r/|api/public/reports/) {
    access_log off;
    proxy_pass http://synrgy:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location / {
    proxy_pass http://synrgy:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```caddy
# Caddy: send report traffic through a handler with logging skipped
hr.example.com {
    @reports path /r/* /api/public/reports/*
    log_skip @reports
    reverse_proxy synrgy:4000
}
```

For managed load balancers (AWS ALB, Cloudflare, etc.), check whether request logs are on and whether they can
exclude paths; if not, consider serving `/r/*` from a separate hostname whose logging is disabled.

## 5. Backups

All state is in PostgreSQL. There are no uploaded files.

**Take nightly logical backups** and keep them encrypted:

```sh
# Custom format: compressed, and allows selective restores
pg_dump --format=custom --no-owner --file=synrgy-$(date +%F).dump "$DATABASE_URL"
# Encrypt before it leaves the machine (example with age)
age -r <recipient-public-key> synrgy-$(date +%F).dump > synrgy-$(date +%F).dump.age
```

Suggested retention: 7 daily, 4 weekly, 12 monthly. Managed Postgres services (RDS, Cloud SQL, Neon, ...) offer
automated backups with point-in-time recovery. Turn that on as well, and still keep the off-site logical dumps.

**Restore** (into an empty database, then start the app; it applies any newer migrations):

```sh
createdb synrgy_restore
pg_restore --no-owner --dbname=synrgy_restore synrgy-2026-11-25.dump
```

**Test restores** at least quarterly: restore the latest dump into a scratch database, point a throwaway container
at it, and check `GET /api/health/ready` plus a sign-in.

Backups contain confidential reports and personal data. Restrict access to them the same way as to the live
database, and remember that deleting data from the live system doesn't remove it from older backups. Set your
retention with your privacy policy in mind.

## 6. Security checklist

- [ ] TLS everywhere; HTTP redirects to HTTPS at the proxy.
- [ ] `CLIENT_ORIGIN` / `APP_URL` set to the real public URL.
- [ ] Proxy and CDN access logs exclude `/r/` and `/api/public/reports/` (section 4).
- [ ] Database not reachable from the internet; app uses a dedicated role; strong password in a secret store.
- [ ] Email provider configured (`MAIL_PROVIDER`), with SPF/DKIM set up for the `MAIL_FROM` domain.
- [ ] Backups encrypted, off-site, restore-tested.
- [ ] At least one independent person per workspace has the report-reviewer flag.
- [ ] Keep the base image updated: rebuild regularly (`docker build --pull`).

## 7. Upgrading

1. Back up the database.
2. Deploy the new image. Migrations run on start; readiness stays `503` until they finish.
3. Migrations only move forward. To roll back the app, restore the pre-upgrade backup
   (or deploy the old image only if the release notes say the schema is backward compatible).
