-- M0 foundation + M1 time clock

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  timezone    text NOT NULL DEFAULT 'UTC',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'manager', 'employee');
CREATE TYPE user_status AS ENUM ('active', 'deactivated');

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email               text NOT NULL,
  password_hash       text NOT NULL,
  first_name          text NOT NULL,
  last_name           text NOT NULL,
  role                user_role NOT NULL DEFAULT 'employee',
  can_review_reports  boolean NOT NULL DEFAULT false,
  manager_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  status              user_status NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_org_email_uq ON users (organization_id, lower(email));
CREATE INDEX users_org_idx ON users (organization_id);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email            text NOT NULL,
  role             user_role NOT NULL DEFAULT 'employee',
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'owner')
);
CREATE INDEX invitations_org_idx ON invitations (organization_id);

-- Time clock ---------------------------------------------------------------

CREATE TYPE entry_source AS ENUM ('clock', 'correction', 'manual');

CREATE TABLE work_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in_at      timestamptz NOT NULL,
  clock_out_at     timestamptz,
  source           entry_source NOT NULL DEFAULT 'clock',
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);
-- A user can have at most one open session.
CREATE UNIQUE INDEX work_sessions_one_open_uq ON work_sessions (user_id) WHERE clock_out_at IS NULL;
CREATE INDEX work_sessions_user_time_idx ON work_sessions (organization_id, user_id, clock_in_at);

CREATE TYPE break_kind AS ENUM ('paid', 'unpaid');

CREATE TABLE breaks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_session_id  uuid NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  kind             break_kind NOT NULL DEFAULT 'unpaid',
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- A session can have at most one open break.
CREATE UNIQUE INDEX breaks_one_open_uq ON breaks (work_session_id) WHERE ended_at IS NULL;

-- Audit ---------------------------------------------------------------------

CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action           text NOT NULL,
  entity           text NOT NULL,
  entity_id        text,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (organization_id, created_at DESC);
