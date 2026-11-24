-- M3 scheduling & shift swaps

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE scheduled_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = open / unassigned
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  position         text,
  location         text,
  notes            text,
  published_at     timestamptz,                                     -- NULL = draft
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '24 hours'),
  -- Nobody can be scheduled for two overlapping shifts, enforced even under concurrent writes.
  CONSTRAINT scheduled_shifts_no_overlap
    EXCLUDE USING gist (user_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (user_id IS NOT NULL)
);
CREATE INDEX scheduled_shifts_org_time_idx ON scheduled_shifts (organization_id, starts_at);

CREATE TYPE swap_type AS ENUM ('swap', 'cover', 'open');
CREATE TYPE swap_status AS ENUM ('pending_peer', 'pending_manager', 'approved', 'declined', 'rejected', 'cancelled');

CREATE TABLE shift_swaps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             swap_type NOT NULL,
  shift_id         uuid NOT NULL REFERENCES scheduled_shifts(id) ON DELETE CASCADE,  -- the requester's shift
  requester_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id   uuid REFERENCES users(id) ON DELETE CASCADE,                      -- swap / cover
  target_shift_id  uuid REFERENCES scheduled_shifts(id) ON DELETE CASCADE,           -- swap only
  accepted_by      uuid REFERENCES users(id) ON DELETE SET NULL,                     -- who took it
  status           swap_status NOT NULL DEFAULT 'pending_peer',
  message          text,
  responded_at     timestamptz,
  reviewer_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note      text,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'open') = (target_user_id IS NULL)),
  CHECK ((type = 'swap') = (target_shift_id IS NOT NULL))
);
-- A shift can be in at most one active swap request.
CREATE UNIQUE INDEX shift_swaps_one_active_uq
  ON shift_swaps (shift_id) WHERE status IN ('pending_peer', 'pending_manager');
CREATE INDEX shift_swaps_org_status_idx ON shift_swaps (organization_id, status);
