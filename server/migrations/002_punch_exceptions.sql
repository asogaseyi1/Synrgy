-- M2 missed-punch exceptions

CREATE TYPE exception_kind AS ENUM (
  'missed_shift',      -- a whole shift was never recorded (creates a new work session)
  'missed_clock_in',   -- clocked in late / forgot and clocked in later
  'missed_clock_out',  -- forgot to clock out
  'missed_break',      -- a break was not logged
  'wrong_time'         -- any other correction to an existing session
);

CREATE TYPE exception_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

CREATE TABLE punch_exceptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_session_id         uuid REFERENCES work_sessions(id) ON DELETE SET NULL,
  kind                    exception_kind NOT NULL,
  status                  exception_status NOT NULL DEFAULT 'pending',
  -- The full corrected state the employee is asking for.
  requested_clock_in_at   timestamptz NOT NULL,
  requested_clock_out_at  timestamptz NOT NULL,
  requested_breaks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Snapshot of the session when the request was filed (null for missed_shift).
  original                jsonb,
  reason                  text NOT NULL,
  reviewer_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note             text,
  reviewed_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_clock_out_at > requested_clock_in_at),
  CHECK ((kind = 'missed_shift') = (original IS NULL))
);

-- Only one pending request per session at a time.
CREATE UNIQUE INDEX punch_exceptions_one_pending_uq
  ON punch_exceptions (work_session_id) WHERE status = 'pending';
CREATE INDEX punch_exceptions_org_status_idx ON punch_exceptions (organization_id, status, created_at DESC);
CREATE INDEX punch_exceptions_user_idx ON punch_exceptions (user_id, created_at DESC);
