# Synrgy

A multi-tenant HR workforce tool. Any company can create a workspace, and its employees can clock in and out, log breaks, swap shifts, read announcements, file missed-punch exceptions and submit anonymous misconduct reports.

Built on the PERN stack (PostgreSQL, Express, React, Node) in TypeScript.
See **[docs/PLAN.md](docs/PLAN.md)** for the architecture, data model and milestone roadmap.

## Status

| Milestone | State |
|---|---|
| M0 Foundation: workspaces, auth, roles, invites | ✅ |
| M1 Time clock: clock in/out, breaks, timesheets, team view | ✅ |
| M2 Missed-punch exceptions: requests, approvals, audit trail | ✅ |
| M3 Scheduling & shift swaps: week grid, drafts/publish, swap/cover/open offers | ✅ |
| M4 Announcements: targeting, pinning, scheduling/expiry, read receipts, acknowledgements | ✅ |
| M5 Anonymous reporting: public form, code + key follow-up, reviewer inbox, audited access | ✅ |
| M6 Making it generic: pay rules & payroll export, departments/locations, email, password reset, rate limiting, CSRF | ✅ |
| M7 Production readiness: CI, Docker image, structured logging, health checks, accessibility, installable PWA | ✅ |

## Getting started

Requirements: Node 22.18+ (runs TypeScript natively) and Docker.

```sh
npm install
cp .env.example .env      # defaults work with docker-compose
npm run db:up             # Postgres 17 on :5432 (also creates synrgy_test)
npm run migrate
npm run dev               # API on :4000, web on :5173 (proxies /api)
```

Open http://localhost:5173, click **Create a workspace**, then invite people from **People**.
In development, emails (invites, password resets, notifications) are printed to the API log; the invite link is
also shown on screen. To send real email, set `MAIL_PROVIDER` (see `.env.example`). If the web app runs somewhere
other than `CLIENT_ORIGIN` (e.g. Vite picked another port), set `APP_URL` so emailed links point to the right place.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + web with reload |
| `npm test` | API integration tests (needs `npm run db:up`) |
| `npm run typecheck` | Typecheck server and client |
| `npm run migrate` | Apply new SQL migrations in `server/migrations` |
| `npm run build -w client` | Production build of the web app (`client/dist`) |
| `docker compose --profile app up --build` | Run the production image locally on http://localhost:8080 |

## Deploying

One Docker image serves the API and the web app; it needs PostgreSQL. See
**[docs/OPERATIONS.md](docs/OPERATIONS.md)** for configuration, health checks, logging (including keeping proxies
from logging anonymous-report traffic), backups and a security checklist. CI runs on every push and pull request
(`.github/workflows/ci.yml`).

## Layout

```
server/
  migrations/      SQL migrations, applied in order (under an advisory lock)
  src/
    app.ts         Express app wiring, static hosting of the built client
    index.ts       entrypoint: migrations, jobs, graceful shutdown
    middleware/    session auth, role checks, rate limiting, CSRF
    routes/        auth, members, time & payroll, exceptions, shifts, swaps, announcements,
                   reports (public + reviewer), organization
    lib/           payroll rules, mailer + notifications, jobs, logger, settings, audit log
  test/            Vitest + Supertest against real Postgres
client/
  public/          PWA manifest, service worker, icons (scripts/make-icons.ts regenerates them)
  src/
    pages/         one file per area
    api.ts         typed fetch wrapper
    auth.tsx       session context
    a11y.ts        focus management, online status
docs/
  PLAN.md          architecture, data model, milestones
  OPERATIONS.md    running it in production
Dockerfile
```
