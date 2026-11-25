-- M6 making it generic: departments & locations, password reset, notification prefs.

CREATE TYPE org_unit_kind AS ENUM ('department', 'location');

CREATE TABLE org_units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind             org_unit_kind NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX org_units_name_uq ON org_units (organization_id, kind, lower(name));

ALTER TABLE users
  ADD COLUMN department_id uuid REFERENCES org_units(id) ON DELETE SET NULL,
  ADD COLUMN location_id uuid REFERENCES org_units(id) ON DELETE SET NULL,
  ADD COLUMN email_notifications boolean NOT NULL DEFAULT true;

-- Announcements can also target a department and/or a location.
ALTER TABLE announcements
  ADD COLUMN audience_department_id uuid REFERENCES org_units(id) ON DELETE CASCADE,
  ADD COLUMN audience_location_id uuid REFERENCES org_units(id) ON DELETE CASCADE;

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Background jobs that should run at most once per org per day (e.g. the reviewer digest).
CREATE TABLE job_runs (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job              text NOT NULL,
  run_on           date NOT NULL,
  PRIMARY KEY (organization_id, job, run_on)
);
