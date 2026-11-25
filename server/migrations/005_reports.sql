-- M5 anonymous reporting.
-- Privacy by construction: no column here can identify the reporter (no user id, IP, user agent),
-- and every date is a calendar day, never a precise time.

CREATE TYPE report_status AS ENUM ('new', 'investigating', 'resolved', 'dismissed');
CREATE TYPE report_author AS ENUM ('reporter', 'reviewer');

CREATE TABLE reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tracking_code    text NOT NULL UNIQUE,            -- 10 chars, Crockford base32
  access_key_hash  text NOT NULL,                   -- bcrypt of the reporter's secret key
  category         text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  description      text NOT NULL CHECK (length(description) BETWEEN 1 AND 10000),
  incident_date    date,
  location         text CHECK (length(location) <= 200),
  people_involved  text CHECK (length(people_involved) <= 500),
  status           report_status NOT NULL DEFAULT 'new',
  created_on       date NOT NULL,                   -- day only, org time zone
  updated_on       date NOT NULL,
  closed_on        date
);
CREATE INDEX reports_org_status_idx ON reports (organization_id, status);

CREATE TABLE report_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  seq          integer NOT NULL,                    -- order within the report (no global sequence)
  author_kind  report_author NOT NULL,
  reviewer_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_on   date NOT NULL,
  UNIQUE (report_id, seq),
  CHECK (author_kind = 'reviewer' OR reviewer_id IS NULL)
);
