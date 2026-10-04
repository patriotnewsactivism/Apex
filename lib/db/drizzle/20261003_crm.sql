-- CRM contact book. Additive only.
-- The unique audit_events index is replaced by a non-unique index so one
-- entity can accumulate many audit rows. That DROP INDEX is the index
-- replacement requested for the audit trail; it does not drop data.
-- contact_timeline is append-only: triggers reject UPDATE and DELETE.
-- Statements are split on the "-- STATEMENT" marker by lib/db/src/crm-migration.ts.

-- STATEMENT
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  name varchar(255) NOT NULL,
  domain varchar(255),
  website text,
  industry varchar(100),
  employee_count integer,
  estimated_revenue numeric(12,2),
  address jsonb,
  linkedin_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  company_id uuid,
  first_name varchar(100),
  last_name varchar(100),
  title varchar(200),
  email varchar(255),
  phone_e164 varchar(20),
  phone_type text,
  timezone varchar(50),
  location jsonb,
  source text,
  status text NOT NULL DEFAULT 'active',
  organization_name text,
  website text,
  social_handles jsonb NOT NULL DEFAULT '{}'::jsonb,
  city varchar(120),
  state varchar(80),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  notes text,
  owner_bot text,
  do_not_contact boolean NOT NULL DEFAULT false,
  do_not_contact_reason text,
  do_not_contact_set_by text,
  do_not_contact_set_at timestamptz,
  last_contacted_at timestamptz,
  last_reply_at timestamptz,
  next_follow_up_at timestamptz,
  follow_up_paused boolean NOT NULL DEFAULT false,
  search_vector tsvector,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS organization_name text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS website text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS social_handles jsonb NOT NULL DEFAULT '{}'::jsonb;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city varchar(120);
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state varchar(80);
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[];
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_bot text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_reason text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_set_by text;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_set_at timestamptz;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_reply_at timestamptz;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS next_follow_up_at timestamptz;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS follow_up_paused boolean NOT NULL DEFAULT false;
-- STATEMENT
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_organization_id_idx ON contacts (organization_id);
-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique ON contacts (organization_id, email) WHERE email IS NOT NULL;
-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_unique ON contacts (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;
-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_tags_gin_idx ON contacts USING gin (tags);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_search_idx ON contacts USING gin (search_vector);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_owner_bot_idx ON contacts (owner_bot);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_city_state_idx ON contacts (city, state);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contacts_dnc_idx ON contacts (do_not_contact);

-- STATEMENT
CREATE TABLE IF NOT EXISTS contact_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL,
  kind text NOT NULL,
  value text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  source_url text,
  found_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_identifiers_contact_id_idx ON contact_identifiers (contact_id);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_identifiers_kind_value_idx ON contact_identifiers (kind, lower(value));
-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS contact_identifiers_contact_kind_value_unique
  ON contact_identifiers (contact_id, kind, lower(value));

-- STATEMENT
CREATE TABLE IF NOT EXISTS interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  campaign_id uuid,
  contact_id uuid,
  company_id uuid,
  channel text NOT NULL,
  direction text NOT NULL,
  type text,
  provider text,
  external_id text,
  status text,
  subject varchar(500),
  body_summary text,
  body_text text,
  body_html text,
  provider_message_id text,
  email_message_id text,
  in_reply_to text,
  references_header text,
  actor_type text,
  actor_name text,
  structured_outcome jsonb,
  occurred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS body_text text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS body_html text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS provider_message_id text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS email_message_id text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS in_reply_to text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS references_header text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS actor_type text;
-- STATEMENT
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS actor_name text;
-- STATEMENT
CREATE INDEX IF NOT EXISTS interactions_email_message_id_idx ON interactions (email_message_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS contact_timeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid,
  channel text NOT NULL,
  direction text NOT NULL,
  actor_type text NOT NULL,
  actor_name text NOT NULL,
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  subject text,
  body_text text,
  body_html text,
  provider text,
  provider_message_id text,
  email_message_id text,
  in_reply_to text,
  references_header text,
  reply_token text,
  interaction_id uuid,
  send_record_table text,
  send_record_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_vector tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_timeline_contact_occurred_idx ON contact_timeline (contact_id, occurred_at DESC);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_timeline_organization_id_idx ON contact_timeline (organization_id);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_timeline_reply_token_idx ON contact_timeline (reply_token) WHERE reply_token IS NOT NULL;
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_timeline_email_message_id_idx ON contact_timeline (email_message_id) WHERE email_message_id IS NOT NULL;
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_timeline_search_idx ON contact_timeline USING gin (search_vector);
-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS contact_timeline_provider_message_unique
  ON contact_timeline (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- STATEMENT
CREATE TABLE IF NOT EXISTS inbound_unmatched (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  channel text NOT NULL DEFAULT 'email',
  from_address text,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text,
  body_text text,
  body_html text,
  email_message_id text,
  in_reply_to text,
  references_header text,
  provider_message_id text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'unmatched',
  attached_contact_id uuid,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE INDEX IF NOT EXISTS inbound_unmatched_status_idx ON inbound_unmatched (status, received_at DESC);

-- STATEMENT
CREATE TABLE IF NOT EXISTS contact_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  winner_id uuid NOT NULL,
  loser_id uuid NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS contact_merges_loser_unique ON contact_merges (loser_id);
-- STATEMENT
CREATE INDEX IF NOT EXISTS contact_merges_winner_idx ON contact_merges (winner_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_legacy_links (
  source_table text NOT NULL,
  source_id text NOT NULL,
  contact_id uuid,
  timeline_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS crm_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  account_email text NOT NULL,
  encrypted_token text NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE UNIQUE INDEX IF NOT EXISTS crm_oauth_tokens_provider_email_unique ON crm_oauth_tokens (provider, account_email);

-- STATEMENT
CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  contact_id uuid,
  provider text,
  external_event_id text,
  title varchar(500) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  meeting_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS meeting_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'attendee',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
DROP INDEX IF EXISTS audit_events_entity_unique;

-- STATEMENT
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (entity_type, entity_id);

-- STATEMENT
CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  contact_id uuid,
  email varchar(255),
  phone_e164 varchar(20),
  channel text NOT NULL,
  reason text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  mission_id text,
  name varchar(200) NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  audience_filter jsonb,
  daily_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS campaign_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_step_id uuid,
  next_action_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  stop_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE TABLE IF NOT EXISTS sequence_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  enrollment_id uuid NOT NULL,
  step_id uuid NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  interaction_id uuid,
  result jsonb,
  error text,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- STATEMENT
CREATE OR REPLACE FUNCTION crm_contacts_search_vector_refresh()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ident text;
  company_name text;
BEGIN
  SELECT coalesce(string_agg(value, ' '), '') INTO ident
  FROM contact_identifiers
  WHERE contact_id = NEW.id;

  SELECT coalesce(name, '') INTO company_name
  FROM companies
  WHERE id = NEW.company_id;

  NEW.search_vector :=
    setweight(to_tsvector('simple',
      coalesce(NEW.first_name, '') || ' ' ||
      coalesce(NEW.last_name, '') || ' ' ||
      coalesce(NEW.organization_name, '') || ' ' ||
      coalesce(company_name, '')
    ), 'A')
    || setweight(to_tsvector('simple',
      coalesce(NEW.title, '') || ' ' ||
      coalesce(NEW.email, '') || ' ' ||
      coalesce(NEW.phone_e164, '') || ' ' ||
      coalesce(NEW.city, '') || ' ' ||
      coalesce(NEW.state, '') || ' ' ||
      coalesce(ident, '')
    ), 'B')
    || setweight(to_tsvector('simple',
      coalesce(array_to_string(NEW.tags, ' '), '') || ' ' ||
      coalesce(NEW.notes, '') || ' ' ||
      coalesce(NEW.website, '')
    ), 'C');
  RETURN NEW;
END;
$$;

-- STATEMENT
DROP TRIGGER IF EXISTS contacts_search_vector_refresh ON contacts;

-- STATEMENT
CREATE TRIGGER contacts_search_vector_refresh
  BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION crm_contacts_search_vector_refresh();

-- STATEMENT
CREATE OR REPLACE FUNCTION crm_touch_contact_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cid uuid;
BEGIN
  cid := COALESCE(NEW.contact_id, OLD.contact_id);
  UPDATE contacts SET updated_at = now() WHERE id = cid;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- STATEMENT
DROP TRIGGER IF EXISTS contact_identifiers_touch_search ON contact_identifiers;

-- STATEMENT
CREATE TRIGGER contact_identifiers_touch_search
  AFTER INSERT OR UPDATE OR DELETE ON contact_identifiers
  FOR EACH ROW
  EXECUTE FUNCTION crm_touch_contact_search();

-- STATEMENT
CREATE OR REPLACE FUNCTION crm_timeline_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.subject, '') || ' ' ||
    coalesce(NEW.body_text, '') || ' ' ||
    coalesce(regexp_replace(coalesce(NEW.body_html, ''), '<[^>]+>', ' ', 'g'), '')
  );
  RETURN NEW;
END;
$$;

-- STATEMENT
DROP TRIGGER IF EXISTS contact_timeline_search_vector ON contact_timeline;

-- STATEMENT
CREATE TRIGGER contact_timeline_search_vector
  BEFORE INSERT ON contact_timeline
  FOR EACH ROW
  EXECUTE FUNCTION crm_timeline_search_vector();

-- STATEMENT
CREATE OR REPLACE FUNCTION crm_reject_timeline_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'contact_timeline is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$;

-- STATEMENT
DROP TRIGGER IF EXISTS contact_timeline_no_update ON contact_timeline;

-- STATEMENT
CREATE TRIGGER contact_timeline_no_update
  BEFORE UPDATE ON contact_timeline
  FOR EACH ROW
  EXECUTE FUNCTION crm_reject_timeline_mutation();

-- STATEMENT
DROP TRIGGER IF EXISTS contact_timeline_no_delete ON contact_timeline;

-- STATEMENT
CREATE TRIGGER contact_timeline_no_delete
  BEFORE DELETE ON contact_timeline
  FOR EACH ROW
  EXECUTE FUNCTION crm_reject_timeline_mutation();
