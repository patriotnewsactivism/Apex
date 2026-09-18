import { sql } from 'drizzle-orm';
import { db } from './client';

export async function migrateRevenueOpsTables() {
  console.log('--- Revenue Ops Remaining Tables Migration ---');

  const stages = [
    // 1. Enums
    sql`
      DO $$ BEGIN
        CREATE TYPE phone_type_enum AS ENUM ('mobile', 'landline', 'voip', 'unknown');
        CREATE TYPE contact_status_enum AS ENUM ('active', 'suppressed', 'archived');
        CREATE TYPE channel_enum AS ENUM ('phone', 'sms', 'email', 'calendar', 'web', 'internal', 'all');
        CREATE TYPE consent_status_enum AS ENUM ('unknown', 'granted', 'denied', 'revoked');
        CREATE TYPE suppression_reason_enum AS ENUM ('opt_out', 'dnc', 'bounced', 'complaint', 'manual', 'legal');
        CREATE TYPE campaign_status_enum AS ENUM ('draft', 'validating', 'ready', 'active', 'paused', 'completed', 'cancelled');
        CREATE TYPE enrollment_status_enum AS ENUM ('pending', 'active', 'waiting', 'responded', 'qualified', 'booked', 'suppressed', 'disqualified', 'completed', 'failed');
        CREATE TYPE call_status_enum AS ENUM ('requested', 'queued', 'initiated', 'ringing', 'answered', 'bridged', 'completed', 'failed', 'cancelled');
        CREATE TYPE call_disposition_enum AS ENUM ('human', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'interested', 'not_interested', 'callback', 'qualified', 'booked', 'dnc', 'failed');
        CREATE TYPE meeting_status_enum AS ENUM ('proposed', 'scheduled', 'completed', 'cancelled', 'no_show');
        CREATE TYPE ledger_category_enum AS ENUM ('ai', 'voice', 'sms', 'email', 'data', 'enrichment', 'other');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,

    // 2. Companies & Contacts
    sql`
      CREATE TABLE IF NOT EXISTS companies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        name TEXT NOT NULL,
        domain TEXT,
        website TEXT,
        industry TEXT,
        employee_count INTEGER,
        estimated_revenue NUMERIC,
        address JSONB,
        linkedin_url TEXT,
        metadata JSONB,
        source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_companies_org ON companies (organization_id);

      CREATE TABLE IF NOT EXISTS contacts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
        first_name TEXT,
        last_name TEXT,
        title TEXT,
        email TEXT,
        phone_e164 TEXT,
        phone_type phone_type_enum DEFAULT 'unknown',
        timezone TEXT,
        location JSONB,
        source TEXT,
        status contact_status_enum NOT NULL DEFAULT 'active',
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts (organization_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts (organization_id, email) WHERE email IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;
    `,

    // 3. Compliance & Suppression
    sql`
      CREATE TABLE IF NOT EXISTS consent_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel channel_enum NOT NULL,
        status consent_status_enum NOT NULL DEFAULT 'unknown',
        consent_type TEXT,
        scope TEXT,
        source TEXT,
        evidence JSONB,
        granted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_consent_records ON consent_records (organization_id, contact_id, channel);

      CREATE TABLE IF NOT EXISTS suppressions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        email TEXT,
        phone_e164 TEXT,
        channel channel_enum NOT NULL DEFAULT 'all',
        reason suppression_reason_enum NOT NULL,
        source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_suppress_email ON suppressions (organization_id, email) WHERE email IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_suppress_phone ON suppressions (organization_id, phone_e164) WHERE phone_e164 IS NOT NULL;
    `,

    // 4. Campaigns, Sequences & Enrollments
    sql`
      CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        mission_id UUID,
        name TEXT NOT NULL,
        status campaign_status_enum NOT NULL DEFAULT 'draft',
        audience_filter JSONB,
        daily_limits JSONB,
        settings JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sequences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sequence_steps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        channel channel_enum NOT NULL,
        delay_seconds INTEGER NOT NULL DEFAULT 0,
        condition JSONB,
        template_id UUID,
        configuration JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS campaign_enrollments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status enrollment_status_enum NOT NULL DEFAULT 'pending',
        current_step_id UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,
        next_action_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        stop_reason TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_enrollment UNIQUE (campaign_id, contact_id)
      );
    `,

    // 5. Interactions, Calls & Provider Webhooks
    sql`
      CREATE TABLE IF NOT EXISTS interactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        mission_id UUID,
        campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
        contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
        channel channel_enum NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        provider TEXT,
        external_id TEXT,
        status TEXT,
        subject TEXT,
        body_summary TEXT,
        structured_outcome JSONB,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        mission_id UUID,
        campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
        external_call_id TEXT,
        call_control_id TEXT,
        call_session_id TEXT,
        from_number TEXT NOT NULL,
        to_number TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'outbound',
        status call_status_enum NOT NULL DEFAULT 'requested',
        disposition call_disposition_enum,
        started_at TIMESTAMPTZ,
        answered_at TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        recording_uri TEXT,
        transcript_id UUID,
        ai_provider TEXT,
        cost_cents BIGINT DEFAULT 0,
        error_code TEXT,
        error_detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS provider_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'received',
        attempt_count INTEGER DEFAULT 0,
        last_error JSONB,
        CONSTRAINT uq_provider_event UNIQUE (provider, external_event_id)
      );
    `,

    // 6. Calendar, Meetings, Pipeline, Ledger & Audits
    sql`
      CREATE TABLE IF NOT EXISTS calendar_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        provider TEXT NOT NULL,
        provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE CASCADE,
        external_calendar_id TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        settings JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        mission_id UUID,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        provider TEXT,
        external_event_id TEXT,
        title TEXT NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        status meeting_status_enum NOT NULL DEFAULT 'scheduled',
        meeting_url TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pipeline_stages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sales_opportunities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
        company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
        mission_id UUID,
        stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        amount_cents BIGINT DEFAULT 0,
        probability NUMERIC,
        source TEXT,
        owner_user_id UUID,
        status TEXT NOT NULL DEFAULT 'open',
        next_action_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        mission_id UUID,
        task_id UUID,
        provider TEXT NOT NULL,
        category ledger_category_enum NOT NULL,
        quantity NUMERIC NOT NULL DEFAULT 1,
        unit TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        external_reference TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id UUID NOT NULL,
        metadata JSONB,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  ];

  for (let i = 0; i < stages.length; i++) {
    console.log(`[${i + 1}/${stages.length}] Applying schema stage...`);
    await db.execute(stages[i]);
  }

  console.log('? All Revenue Ops tables created successfully.');
}

if (process.argv && process.argv.includes('migrate-revenue-ops-tables')) {
  migrateRevenueOpsTables()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
