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
| M7 Production readiness: CI, Docker, logging, PWA | next |

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

## Layout

```
server/
  migrations/      SQL migrations, applied in order
  src/
    app.ts         Express app wiring
    middleware/    session auth + role checks
    routes/        auth, members, time clock, exceptions, shifts, swaps, organization
    lib/           errors, tokens, audit log
  test/            Vitest + Supertest against real Postgres
client/
  src/
    pages/         Auth, Clock, Schedule, Swaps, Timesheet/Team, Requests, Approvals, People, Settings
    api.ts         typed fetch wrapper
    auth.tsx       session context
docs/PLAN.md       roadmap
```
