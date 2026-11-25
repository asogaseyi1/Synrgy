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

### M2 — Missed-punch exceptions ✅
- [x] Employee submits an exception (missed shift, missed clock-in/out, missed break, wrong time) with a reason.
      A request carries the full corrected shift (in, out, breaks) and the server saves a copy of the shift as it was when filed.
- [x] Validation: out after in, nothing in the future, max 31 days back, max 24h shift, breaks inside the shift and not overlapping,
      no overlap with other shifts, one pending request per shift
- [x] Manager (direct reports) or admin approves/rejects; nobody reviews their own; reject requires a note.
      Approval rewrites `work_sessions`/`breaks` in one transaction, marked `source = 'correction'`
- [x] Audit log entry for every correction (before/after) and rejection
- [x] Sessions open > 16h are flagged as `stale`; the clock page prompts the employee to file a correction
- [x] UI: My requests, new request form (times in org time zone), Fix links on the timesheet, Approvals queue with nav badge
- [x] M6: the 16h stale threshold and 31-day window are org settings; reviewers are emailed on new requests (24h max shift stays fixed)

### M3 — Scheduling & shift swaps ✅
- [x] Managers create/edit/delete shifts in a week grid (org time zone, overnight shifts supported); open/unassigned shifts
- [x] Draft → publish workflow; employees only ever see published shifts, but see the whole team's published schedule
- [x] Scope: admins schedule anyone; managers schedule themselves, their direct reports, and open shifts
- [x] No double-booking, enforced by a Postgres exclusion constraint (`btree_gist`), safe under concurrent writes
- [x] Swap flows: **swap** (my shift ⇄ yours), **cover** (you take mine), **open offer** (anyone picks it up)
- [x] Coworker accepts → manager approves (admin or manager of either party; never a party to the swap).
      Org setting `requireSwapApproval` can make swaps go through on acceptance
- [x] Conflict checks at request, acceptance and approval: overlap, and optional `maxWeeklyHours` cap (Mon–Sun, org tz)
- [x] Editing/deleting a shift cancels pending swaps on it; an approved swap cancels other pending requests for the same shifts
- [x] UI: Schedule grid, trade dialog, Swaps page (asked of you / up for grabs / yours), swap tab on Approvals,
      admin Settings page, "Next shift" card on the clock page, nav badges
- [ ] Later: copy last week's schedule, shift templates, employees claiming unassigned open shifts directly,
      availability/time-off, notifications

### M4 — Announcements ✅
- [x] Admins/managers post announcements targeted to everyone, roles, or specific teams.
      Audience = role filter (empty = all) AND team filter (a manager + their direct reports; null = whole org).
      Managers can only post to their own team and manage their own posts; admins manage everything
- [x] Pinning, scheduled publish, expiry (expired posts move to an Archive view)
- [x] Read receipts + "unread" nav badge (viewing the feed marks posts read); authors see read % and a per-person receipts list
- [x] Optional "acknowledgement required" for policy updates, with a banner on the clock page.
      Editing the text of a published post resets acknowledgements and marks it "Edited"
- [x] Audit log entries for create / update / delete
- [ ] Later: rich text / attachments, email or push on publish, reminders for unacknowledged posts,
      targeting by department/location once M6 adds them. Audience is evaluated live, so people who join later also see it

### M5 — Anonymous reporting ✅
- [x] Public submission form `/r/:orgSlug`, no sign-in. The API router (`/api/public/reports`) is mounted **before**
      session loading, so it can't learn who is signed in; the page runs outside the signed-in app (no `/auth/me`),
      sends requests with `credentials: 'omit'`, and keeps nothing in browser storage. Responses are `no-store`;
      errors on these routes log only an error code (Postgres error details can echo values)
- [x] No reporter identity in the schema (a test asserts no user/IP/agent/timestamp columns); dates are days in the
      org time zone; message order is a per-report `seq`, not a global sequence; submitting writes no audit entry
- [x] Tracking code (10 chars) + secret key (20 chars, ~100 bits, bcrypt-hashed) in Crockford base32, shown once,
      with copy and download. Input is forgiving (case, dashes, O→0, I/L→1); wrong code and wrong key give the same answer
- [x] Reviewer inbox (only `can_review_reports`; being an admin isn't enough), status workflow new → investigating →
      resolved/dismissed; replying to a new report moves it to investigating; closed reports stop reporter replies
- [x] Two-way anonymous messaging; the reporter sees replies from "Investigator", not the reviewer's name
- [x] Inbox shows no report content; opening a report is audited every time, and the access log is shown to all reviewers
- [x] Admin settings: report categories, shareable reporting link, reviewer list with a warning when there are none.
      In-app "Speak up" page explains the protections and suggests using a personal device
- [ ] Later: rate limiting on public endpoints (M6), attachments, letting reporters exclude a named reviewer,
      email nudges to reviewers (without content), retention/purge policy for closed reports

### M6 — Making it generic for any company ✅
- [x] Org settings (flat keys in `organizations.settings`, validated, audited): name, time zone, week start (Sun/Mon),
      forgotten-clock-out threshold and correction window (the old M2 constants), punch rounding (5–30 min),
      auto-deducted break (only the shortfall vs. breaks actually taken), daily and weekly overtime thresholds
- [x] Payroll engine (`lib/payroll.ts`, pure + unit-tested): rounding → breaks → auto-deduct → daily OT → weekly OT on
      remaining straight time; days/weeks in the org time zone; raw punches never modified; open shifts excluded and flagged
- [x] Departments & locations (`org_units`), assigned on the People page; filter payroll; target announcements
      (teams remain "a manager + direct reports")
- [x] Payroll page + CSV export (summary and per-shift detail; UTF-8 BOM for Excel; formula-injection safe; exports audited)
- [x] Email (`lib/mailer.ts`, pluggable: console / memory / Resend / generic webhook / none) for invitations, password
      resets, swap requests/approvals/outcomes, time-correction requests/outcomes. Users can opt out of workflow emails.
      Report reviewers get a **daily, content-free digest** instead of per-report emails (an instant email would date the report)
- [x] Rate limiting (in memory, salted-hash keys, never raw IPs): login per IP and per account, registration, password
      reset, invite acceptance, public report submission/access
- [x] CSRF defence in depth on top of SameSite=Lax: reject form-encodable content types and foreign `Origin`s
- [x] Password reset by email (1h, single use, signs out everywhere, no account enumeration); change password
      (keeps this session, ends others); account page
- [ ] Later: SSO (OIDC/SAML), SMTP provider (`npm` install failed in this environment; it's one more entry in `providers`),
      shared rate-limit store for multi-instance deploys, pay periods/approval locks, holiday pay, per-location time zones

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
