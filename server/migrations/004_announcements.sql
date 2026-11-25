-- M4 announcements

CREATE TABLE announcements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body               text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- Audience: both filters must match. Empty roles = every role; NULL team = whole organization.
  audience_roles     user_role[] NOT NULL DEFAULT '{}',
  audience_team_of   uuid REFERENCES users(id) ON DELETE CASCADE,   -- a manager + their direct reports
  pinned             boolean NOT NULL DEFAULT false,
  requires_ack       boolean NOT NULL DEFAULT false,
  publish_at         timestamptz NOT NULL DEFAULT now(),              -- in the future = scheduled
  expires_at         timestamptz,
  content_edited_at  timestamptz,                                     -- title/body changed after publishing
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > publish_at)
);
CREATE INDEX announcements_org_publish_idx ON announcements (organization_id, publish_at DESC);

CREATE TABLE announcement_reads (
  announcement_id  uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at          timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX announcement_reads_user_idx ON announcement_reads (user_id);
