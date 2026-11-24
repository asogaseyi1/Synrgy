# Synrgy — Project Plan

Synrgy is a multi-tenant HR workforce tool. Any company, from a 5-person shop to a large
enterprise, can sign up as its own **organization** and give its employees time tracking,
shift swaps, announcements, missed-punch exceptions, and an anonymous misconduct-reporting channel.

Stack: **P**ostgreSQL · **E**xpress · **R**eact (Vite) · **N**ode, all in TypeScript, in an npm-workspaces monorepo.

---

## 1. Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Repo layout | npm workspaces: `server/`, `client/` | One install, shared scripts, no extra tooling |
| Language | TypeScript (server runs on Node's built-in type stripping) | Type safety without a build step in development |
| Multi-tenancy | Shared schema; every tenant table has `organization_id` | Simplest model that scales to many small tenants. Every query is scoped by the org from the session, never from client input |
| Auth | Server-side sessions in Postgres, sent as an httpOnly cookie | Can be revoked instantly (needed when someone is fired), no JWT pitfalls |
| Login identity | Workspace slug + email | One person can belong to several companies |
| Passwords | bcrypt (`bcryptjs`, pure JS) | No native build on Windows |
| Validation | `zod` on every request body | One schema covers parsing and types |
| DB access | `pg` with hand-written SQL plus a small migration runner | No ORM to learn; SQL stays visible and reviewable |
| Time storage | `timestamptz` everywhere; org has an IANA `timezone` | Correct for companies spread across time zones |
| Roles | `owner`, `admin`, `manager`, `employee` + a separate `can_review_reports` flag | Report reviewers are designated separately, because the person being reported may be an admin |

### Anonymous reporting design (privacy by construction)
- The reports tables have **no column that can identify the reporter**: no user id, no IP address, no user agent.
- Submitting goes through a **public, unauthenticated** endpoint (`/r/:orgSlug`), so employees can report from a personal device without logging in. The in-app link opens the same form.
- Request logging is **turned off** for report routes.
- `created_at` is stored **rounded down to the day** so the time can't be matched against clock-in records.
- The reporter gets a **tracking code + secret key** (only a bcrypt hash of the key is stored). With these they can check status and exchange messages with investigators while staying anonymous.
- Only users with `can_review_reports` can read reports. Each time a reviewer opens a report, it goes into the audit log.

---

## 2. Data model (core tables)

```
organizations     id, name, slug, timezone, settings(jsonb)
users             id, organization_id, email, password_hash, first_name, last_name,
                  role, can_review_reports, manager_id, status
sessions          id(token hash), user_id, expires_at
invitations       id, organization_id, email, role, token_hash, expires_at, accepted_at

work_sessions     id, organization_id, user_id, clock_in_at, clock_out_at, source, notes
                  -- partial unique index: one open session per user
breaks            id, work_session_id, started_at, ended_at, kind(paid|unpaid)
                  -- partial unique index: one open break per session

scheduled_shifts  id, organization_id, user_id?, starts_at, ends_at, position, location, published
shift_swaps       id, organization_id, shift_id, requester_id, target_user_id?, target_shift_id?,
                  status(pending_peer → pending_manager → approved | rejected | cancelled)

punch_exceptions  id, organization_id, user_id, work_session_id?, kind, requested_clock_in_at,
                  requested_clock_out_at, requested_breaks(jsonb), reason, status, reviewer_id, review_note

announcements     id, organization_id, author_id, title, body, audience(jsonb), pinned, publish_at, expires_at
announcement_reads announcement_id, user_id, read_at

reports           id, organization_id, tracking_code, access_key_hash, category, description,
                  status, created_on(date)          -- NO reporter identity
report_messages   id, report_id, author_kind(reporter|reviewer), reviewer_id?, body, created_on

audit_log         id, organization_id, actor_id?, action, entity, entity_id, data(jsonb), created_at
```

---

## 3. Milestones

Each milestone ends with working API + UI + tests and can be shipped on its own.

### M0 — Foundation ✅ *(built in this pass)*
- [x] Monorepo, TypeScript config, lint-free scripts
- [x] `docker-compose.yml` for Postgres; `.env.example`
- [x] SQL migration runner + initial schema
- [x] Organization sign-up (creates org + owner)
- [x] Login / logout / `me` with session cookies
- [x] Role-based access middleware; tenant scoping helper
- [x] Admin: invite employees, accept invite, list/deactivate members
- [x] React shell: auth pages, protected layout, nav by role
- [x] API integration tests (Vitest + Supertest against real Postgres)

### M1 — Time clock ✅ *(built in this pass)*
- [x] Clock in / clock out / start break / end break, with state-machine rules
- [x] Current status endpoint ("clocked in since 9:02, on break")
- [x] Personal timesheet: sessions for a date range, worked vs. break totals
- [x] Manager view: team timesheets
- [x] UI: big clock button, live timer, timesheet table

### M2 — Missed-punch exceptions
- [ ] Employee submits an exception (missed clock-in/out, missed break, wrong time) with a reason
- [ ] Manager approve/reject with a note; approval applies the correction to `work_sessions`/`breaks` in a transaction
- [ ] Audit log entry for every correction (before/after)
- [ ] Auto-flag sessions left open past N hours (org setting) and prompt the employee to file an exception

### M3 — Scheduling & shift swaps
- [ ] Managers create/publish shifts (week view); employees see "My schedule"
- [ ] Swap flows: **direct swap** (my shift ↔ your shift), **cover** (you take my shift), **open offer** (anyone eligible)
- [ ] Peer accepts, then a manager approves (org setting: manager approval required yes/no)
- [ ] Conflict checks (overlap, max hours/week)

### M4 — Announcements
- [ ] Admins/managers post announcements targeted to everyone, roles, or specific teams
- [ ] Pinning, scheduled publish, expiry
- [ ] Read receipts + "unread" badge; admins see read percentage
- [ ] Optional "acknowledgement required" for policy updates

### M5 — Anonymous reporting
- [ ] Public submission form `/r/:orgSlug` (no auth, no logging)
- [ ] Tracking code + key shown once; reporter follow-up page
- [ ] Reviewer inbox (only `can_review_reports`), status workflow (new → investigating → resolved/dismissed)
- [ ] Two-way anonymous messaging
- [ ] Admin setting to choose report categories; audit every reviewer access

### M6 — Making it generic for any company
- [ ] Org settings: timezone, week start, break rules (paid/unpaid, auto-deduct), rounding, overtime thresholds
- [ ] Locations / departments / teams
- [ ] CSV export of timesheets (payroll handoff)
- [ ] Email notifications (pluggable provider) for invites, swap requests, approvals
- [ ] Rate limiting, CSRF protection, password reset, optional SSO later

### M7 — Production readiness
- [ ] CI (GitHub Actions): typecheck, test against Postgres service
- [ ] Production Dockerfile; server serves built client
- [ ] Structured logging (with report routes excluded), health checks, backups doc
- [ ] Accessibility pass, mobile-friendly clock page (installable PWA for kiosks/phones)

---

## 4. Conventions
- API base: `/api`. Errors: `{ error: { code, message, details? } }`.
- Every tenant query includes `organization_id = req.auth.organizationId`.
- Migrations: `server/migrations/NNN_name.sql`, applied in order, recorded in `schema_migrations`.
- Tests: `server/test/*.test.ts`. Each test file creates its own org, so test files don't affect each other.
