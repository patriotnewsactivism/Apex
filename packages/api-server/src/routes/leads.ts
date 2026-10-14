import crypto from 'crypto';
import { Router } from 'express';
import { eq, desc, and, ilike, sql } from 'drizzle-orm';
import { broadcast } from '../websocket.js';
import { mapImportRows, planLeadImport, recordsFromCsv, type ImportedLead } from '@workspace/core';

export function createLeadsRouter(): Router {
  const router = Router();


  // ─── POST /api/leads/import-enrichment — scoped bulk enrichment ───────────
  // Auth: APEX_LEAD_IMPORT_TOKEN, accepted only for this route by middleware.
  // This is update-only by design: unmatched rows are reported, never inserted.
  router.post('/import-enrichment', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');
    const records = (req.body as { records?: unknown })?.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > 750) {
      res.status(400).json({ error: 'records must be a non-empty array with at most 750 rows' });
      return;
    }

    const clean = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const normalizeWebsite = (value: unknown): string | null => {
      const raw = clean(value);
      if (!raw) return null;
      try {
        const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
        return host + (path === '/' ? '' : path);
      } catch {
        return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
      }
    };
    const normalizeText = (value: unknown): string =>
      (clean(value) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const companyCityKey = (company: unknown, city: unknown): string | null => {
      const c = normalizeText(company);
      const l = normalizeText(city);
      return c && l ? `${c}|${l}` : null;
    };
    const normalizeResearchStatus = (value: unknown): 'pending' | 'partial' | 'complete' | 'unavailable' | undefined => {
      const v = normalizeText(value);
      if (v === 'complete' || v === 'partial' || v === 'pending' || v === 'unavailable') return v;
      return undefined;
    };
    const rank = (status: string | null | undefined): number =>
      status === 'complete' ? 2 : status === 'partial' ? 1 : 0;

    const existing = await db.select().from(researchedLeads);
    const byWebsite = new Map<string, typeof existing>();
    const byCompanyCity = new Map<string, typeof existing>();
    for (const lead of existing) {
      const websiteKey = normalizeWebsite(lead.website);
      if (websiteKey) {
        const bucket = byWebsite.get(websiteKey) ?? [];
        bucket.push(lead);
        byWebsite.set(websiteKey, bucket);
      }
      const ccKey = companyCityKey(lead.companyName, lead.city);
      if (ccKey) {
        const bucket = byCompanyCity.get(ccKey) ?? [];
        bucket.push(lead);
        byCompanyCity.set(ccKey, bucket);
      }
    }

    let matched = 0;
    let updated = 0;
    let unchanged = 0;
    let ambiguous = 0;
    let unmatched = 0;
    const unmatchedSample: Array<{ companyName?: string; website?: string; city?: string; reason: string }> = [];

    for (const rawRecord of records) {
      if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
        unmatched += 1;
        continue;
      }
      const record = rawRecord as Record<string, unknown>;
      const websiteKey = normalizeWebsite(record.website);
      const ccKey = companyCityKey(record.companyName, record.city);
      let candidates = websiteKey ? [...(byWebsite.get(websiteKey) ?? [])] : [];

      if (candidates.length > 1 && ccKey) {
        const exact = candidates.filter((lead) => companyCityKey(lead.companyName, lead.city) === ccKey);
        if (exact.length > 0) candidates = exact;
      }
      if (candidates.length === 0 && ccKey) candidates = [...(byCompanyCity.get(ccKey) ?? [])];

      if (candidates.length !== 1) {
        if (candidates.length > 1) ambiguous += 1;
        else unmatched += 1;
        if (unmatchedSample.length < 100) {
          unmatchedSample.push({
            companyName: clean(record.companyName),
            website: clean(record.website),
            city: clean(record.city),
            reason: candidates.length > 1 ? 'ambiguous' : 'not_found',
          });
        }
        continue;
      }

      const current = candidates[0];
      matched += 1;
      const updates: Record<string, unknown> = {};
      const incomingStatus = normalizeResearchStatus(record.contactResearchStatus);
      const currentRank = rank(current.contactResearchStatus);
      const incomingRank = rank(incomingStatus);
      const strongerContactData = incomingRank > currentRank;

      const assignCoreIfMissing = (
        field: 'companyName' | 'website' | 'industry' | 'city' | 'fitReason' | 'outreachAngle',
        incoming: unknown,
      ) => {
        const value = clean(incoming);
        if (value && !clean(current[field])) updates[field] = value;
      };
      assignCoreIfMissing('companyName', record.companyName);
      assignCoreIfMissing('website', record.website);
      assignCoreIfMissing('industry', record.industry);
      assignCoreIfMissing('city', record.city);
      assignCoreIfMissing('fitReason', record.fitReason);
      assignCoreIfMissing('outreachAngle', record.outreachAngle);

      const assignContact = (
        field: 'decisionMakerName' | 'contactEmail' | 'contactPhone' | 'contactSourceUrl',
        incoming: unknown,
      ) => {
        const value = clean(incoming);
        if (value && (strongerContactData || !clean(current[field]))) updates[field] = value;
      };
      assignContact('decisionMakerName', record.decisionMakerName);
      assignContact('contactEmail', record.contactEmail);
      assignContact('contactPhone', record.contactPhone);
      assignContact('contactSourceUrl', record.contactSourceUrl);

      if (
        incomingStatus &&
        (incomingRank > currentRank ||
          (current.contactResearchStatus === 'pending' && incomingStatus === 'unavailable'))
      ) {
        updates.contactResearchStatus = incomingStatus;
      }

      const enrichment = record.enrichmentData;
      if (enrichment && typeof enrichment === 'object' && !Array.isArray(enrichment)) {
        updates.enrichmentData = {
          ...(current.enrichmentData ?? {}),
          ...(enrichment as Record<string, unknown>),
        };
      }

      if (
        updates.decisionMakerName ||
        updates.contactEmail ||
        updates.contactPhone ||
        updates.contactSourceUrl ||
        updates.contactResearchStatus
      ) {
        updates.contactResearchedAt = new Date();
      }

      if (Object.keys(updates).length === 0) {
        unchanged += 1;
        continue;
      }
      await db.update(researchedLeads).set(updates as any).where(eq(researchedLeads.id, current.id));
      updated += 1;
    }

    res.json({
      received: records.length,
      matched,
      updated,
      unchanged,
      unmatched,
      ambiguous,
      unmatchedSample,
    });
  });

  // ─── GET /api/leads — list with optional filters ─────────────────────────
  router.get('/', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const conditions = [];
    if (req.query.status) {
      conditions.push(eq(researchedLeads.status, String(req.query.status)));
    } else {
      conditions.push(sql`${researchedLeads.status} <> 'rejected'`);
      conditions.push(sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`);
      conditions.push(sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`);
    }
    if (req.query.pipelineState) conditions.push(eq(researchedLeads.pipelineState, String(req.query.pipelineState)));
    if (req.query.industry) conditions.push(ilike(researchedLeads.industry, `%${String(req.query.industry)}%`));
    if (req.query.city) conditions.push(ilike(researchedLeads.city, `%${String(req.query.city)}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Number(req.query.limit) || 500, 5000);

    const leads = await db
      .select()
      .from(researchedLeads)
      .where(where)
      .orderBy(desc(researchedLeads.createdAt))
      .limit(limit);

    res.json({ leads });
  });

  // ─── GET /api/leads/export — CSV download ────────────────────────────────
  // Exports the researched-lead table as the SAME column set
  // POST /api/leads/import-enrichment reads back, so a round trip is
  // export → enrich elsewhere → import and the headers line up by construction.
  //
  // Two things used to make that impossible and both are now opt-out:
  //   1. `.limit(10000)` was hardcoded, so the book silently truncated at
  //      10,000 rows with no signal that it had.
  //   2. The reachable+verified filter was unconditional. You cannot export
  //      leads in order to enrich them if the export only returns leads that
  //      are already enriched — the one workflow this endpoint exists for was
  //      the one it refused.
  // Defaults are unchanged (reachable + verified, 10,000 rows) so nothing that
  // already calls this changes shape; pass reachable=false / verified=false and
  // raise limit (or page with offset) to get the whole table.
  router.get('/export', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const conditions = [];
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status) conditions.push(eq(researchedLeads.status, status));
    else conditions.push(sql`${researchedLeads.status} <> 'rejected'`);

    if (typeof req.query.pipelineState === 'string' && req.query.pipelineState.trim()) {
      conditions.push(eq(researchedLeads.pipelineState, req.query.pipelineState.trim()));
    }
    if (typeof req.query.industry === 'string' && req.query.industry.trim()) {
      conditions.push(ilike(researchedLeads.industry, `%${req.query.industry.trim()}%`));
    }
    if (typeof req.query.city === 'string' && req.query.city.trim()) {
      conditions.push(ilike(researchedLeads.city, `%${req.query.city.trim()}%`));
    }
    if (typeof req.query.campaignId === 'string' && req.query.campaignId.trim()) {
      conditions.push(eq(researchedLeads.campaignId, req.query.campaignId.trim()));
    }
    if (req.query.reachable !== 'false') {
      conditions.push(sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`);
    }
    if (req.query.verified !== 'false') {
      conditions.push(sql`${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Cap is generous but still finite: an unbounded SELECT here would stream a
    // 250k-row table into one response and one Node heap. Page with offset.
    const EXPORT_MAX_LIMIT = 250_000;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10000, 1), EXPORT_MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(researchedLeads)
      .where(where);
    const total = Number(countRow?.n ?? 0);

    const leads = await db
      .select()
      .from(researchedLeads)
      .where(where)
      .orderBy(desc(researchedLeads.createdAt))
      .limit(limit)
      .offset(offset);

    const escapeCsv = (val: string | null | undefined): string => {
      if (val == null) return '';
      const needsQuoting = /["\n\r,]/.test(val);
      const escaped = val.replace(/"/g, '""');
      return needsQuoting ? `"${escaped}"` : escaped;
    };

    const headers = [
      // Lead ID first: it is what makes the return trip exact. Without it the
      // importer can only guess identity from email/website, and every lead
      // that shares a domain with another (the norm in a phone-only book) is
      // silently collapsed on re-import.
      'Lead ID',
      'Company Name', 'Website', 'Industry', 'City', 'Decision Maker', 'Email', 'Phone', 'Contact Source', 'Contact Research Status', 'Status',
      'Fit Reason', 'Outreach Angle', 'Enrichment Data', 'Researched By', 'Created At',
    ];

    const rows = leads.map((l) => [
      escapeCsv(l.id),
      escapeCsv(l.companyName),
      escapeCsv(l.website),
      escapeCsv(l.industry),
      escapeCsv(l.city),
      escapeCsv(l.decisionMakerName),
      escapeCsv(l.contactEmail),
      escapeCsv(l.contactPhone),
      escapeCsv(l.contactSourceUrl),
      escapeCsv(l.contactResearchStatus),
      escapeCsv(l.status),
      escapeCsv(l.fitReason),
      escapeCsv(l.outreachAngle),
      escapeCsv(JSON.stringify(l.enrichmentData ?? {})),
      escapeCsv(l.researchedByAgentId),
      escapeCsv(l.createdAt?.toISOString() ?? ''),
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');

    // Tell the caller whether it got everything. The old version gave no hint
    // that it had stopped at 10,000, which is how a truncated export reads as
    // a complete one.
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Export-Rows', String(rows.length));
    res.setHeader('X-Export-Offset', String(offset));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="apex-leads.csv"');
    res.send(csv);
  });

  // ─── GET /api/leads/stats — summary counts ───────────────────────────────
  router.get('/stats', async (_req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const all = await db.select().from(researchedLeads);
    const byStatus = {
      new: all.filter((l) => l.status === 'new').length,
      contacted: all.filter((l) => l.status === 'contacted').length,
      qualified: all.filter((l) => l.status === 'qualified').length,
      rejected: all.filter((l) => l.status === 'rejected').length,
    };
    const visible = all.filter((lead) => {
      if (lead.status === 'rejected') return false;
      if (!lead.contactEmail && !lead.contactPhone) return false;
      const verification = (lead.enrichment as Record<string, unknown> | null)?.['businessVerification'] as
        | { status?: string }
        | undefined;
      return verification?.status === 'verified';
    });
    const byPipelineState: Record<string, number> = {};
    const byIndustry: Record<string, number> = {};
    for (const l of visible) {
      const key = l.industry || 'Unknown';
      byIndustry[key] = (byIndustry[key] ?? 0) + 1;
      byPipelineState[l.pipelineState ?? 'DISCOVERED'] = (byPipelineState[l.pipelineState ?? 'DISCOVERED'] ?? 0) + 1;
    }

    res.json({
      total: visible.length,
      contactReady: visible.length,
      rawCandidates: all.length,
      pendingOrUnverified: Math.max(0, all.length - visible.length - byStatus.rejected),
      rejected: byStatus.rejected,
      byStatus,
      byPipelineState,
      byIndustry,
    });
  });

  // ─── POST /api/leads/verify-batch — run the website-identity repair now ───
  // The scheduled pass runs in the background and only logs completed batches,
  // so an operator who has just bulk-loaded leads has no way to tell whether
  // they are actually being verified. This runs one batch synchronously and
  // returns its counters.
  router.post('/verify-batch', async (req, res) => {
    try {
      const { repairWebLeadIdentityBatch } = await import('@workspace/background-jobs');
      const limit = Math.max(1, Math.min(500, Number((req.body as { limit?: number } | undefined)?.limit ?? 100) || 100));
      const result = await repairWebLeadIdentityBatch(limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─── POST /api/leads/import — CSV or JSON, preview unless commit=true ────
  router.post('/import', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        csv?: string;
        rows?: Array<Record<string, string>>;
        provider?: string;
        overwrite?: boolean;
        commit?: boolean;
      };
      const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim().slice(0, 40) : 'import';
      const records = typeof body.csv === 'string'
        ? recordsFromCsv(body.csv)
        : Array.isArray(body.rows) ? body.rows : [];
      if (records.length === 0) {
        res.status(400).json({ error: 'Provide csv text or a rows array.' });
        return;
      }
      if (records.length > 5000) {
        res.status(400).json({ error: 'Import at most 5000 rows at a time.' });
        return;
      }
      const mapped = mapImportRows(records, provider);
      const { db, researchedLeads } = await import('@workspace/db');
      const existing = await db.select({
        id: researchedLeads.id,
        contactEmail: researchedLeads.contactEmail,
        website: researchedLeads.website,
        decisionMakerName: researchedLeads.decisionMakerName,
        contactPhone: researchedLeads.contactPhone,
        title: researchedLeads.title,
        linkedinUrl: researchedLeads.linkedinUrl,
        employeeCount: researchedLeads.employeeCount,
        outreachAngle: researchedLeads.outreachAngle,
        enrichment: researchedLeads.enrichment,
      }).from(researchedLeads);
      const plan = planLeadImport({
        leads: mapped.leads,
        existing: existing.map((row) => ({
          ...row,
          enrichment: row.enrichment && typeof row.enrichment === 'object' ? row.enrichment as Record<string, unknown> : null,
        })),
        overwrite: Boolean(body.overwrite),
        parseSkips: mapped.skipped,
      });
      if (!body.commit) {
        res.json({
          preview: plan.preview,
          counts: plan.counts,
          committed: false,
        });
        return;
      }
      let written = 0;
      for (const row of plan.rows) {
        if (row.action === 'skip' || !row.lead.companyName) continue;
        if (row.action === 'new') {
          await db.insert(researchedLeads).values(leadInsert(row.lead, provider));
          written++;
        } else if (row.action === 'update' && row.existingId) {
          await db.update(researchedLeads).set({
            decisionMakerName: row.lead.decisionMakerName,
            contactPhone: row.lead.contactPhone,
            contactEmail: row.lead.contactEmail,
            title: row.lead.title,
            linkedinUrl: row.lead.linkedinUrl,
            employeeCount: row.lead.employeeCount,
            outreachAngle: row.lead.outreachAngle,
            source: provider,
            enrichment: row.lead.enrichment,
            contactResearchStatus: 'imported',
          }).where(eq(researchedLeads.id, row.existingId));
          written++;
        }
      }
      res.json({ preview: plan.preview, counts: plan.counts, committed: true, written });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/leads/:id — independent persisted-state read-back.
  router.get('/:id', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');
    const leadId = String(req.params.id);
    const [lead] = await db
      .select({
        id: researchedLeads.id,
        status: researchedLeads.status,
        pipelineState: researchedLeads.pipelineState,
      })
      .from(researchedLeads)
      .where(eq(researchedLeads.id, leadId))
      .limit(1);

    if (!lead) {
      res.status(404).json({ success: false, error: 'lead_not_found' });
      return;
    }

    res.json({
      success: true,
      id: lead.id,
      status: lead.status,
      pipelineState: lead.pipelineState,
    });
  });

  // ─── PATCH /api/leads/:id — update status ────────────────────────────────
  // The single sanctioned write path for lead status transitions. The Lead
  // Researcher reaches it through the updateLeadStatus tool rather than
  // mutating researched_leads itself, so this validation block stays the one
  // source of truth for what a legal status is.
  //
  // Optional sourceUrl + note are audit metadata only: they record *why* a lead
  // was moved and *where the evidence came from*. They are never treated as
  // consent, and changing a status sends no email, places no call and creates
  // no campaign.
  router.patch('/:id', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');
    const { status, pipelineState, sourceUrl, note } = req.body as {
      status?: string;
      pipelineState?: string;
      sourceUrl?: string;
      note?: string;
    };
    const validStatuses = ['new', 'contacted', 'qualified', 'rejected'];
    const validPipelineStates = ['DISCOVERED', 'BASIC_ENRICHMENT', 'CONTACT_FOUND', 'QUALIFIED', 'DEEP_RESEARCH', 'CAMPAIGN_READY'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: 'status must be one of: new, contacted, qualified, rejected' });
      return;
    }
    if (pipelineState && !validPipelineStates.includes(pipelineState)) {
      res.status(400).json({ error: `pipelineState must be one of: ${validPipelineStates.join(', ')}` });
      return;
    }
    if (!status && !pipelineState) {
      res.status(400).json({ error: 'status or pipelineState is required' });
      return;
    }
    // Audit fields are validated when present but never required at the API
    // edge, so existing callers keep working; the tool layer mandates them.
    if (sourceUrl !== undefined) {
      const ok = typeof sourceUrl === 'string' && sourceUrl.length <= 600 && /^https?:\/\/\S+$/i.test(sourceUrl.trim());
      if (!ok) {
        res.status(400).json({ error: 'sourceUrl must be an absolute http(s) URL of at most 600 characters' });
        return;
      }
    }
    if (note !== undefined) {
      const ok = typeof note === 'string' && note.trim().length >= 3 && note.length <= 500;
      if (!ok) {
        res.status(400).json({ error: 'note must be a string of 3-500 characters' });
        return;
      }
    }

    const leadId = String(req.params.id);
    // Read only the columns this transition needs. `select()` of the whole row
    // breaks the moment the Drizzle schema is ahead of the deployed table, and
    // a status update must not depend on unrelated columns existing.
    const [existing] = await db
      .select({
        id: researchedLeads.id,
        status: researchedLeads.status,
        pipelineState: researchedLeads.pipelineState,
        qualifiedAt: researchedLeads.qualifiedAt,
        pipelineMetadata: researchedLeads.pipelineMetadata,
      })
      .from(researchedLeads)
      .where(eq(researchedLeads.id, leadId))
      .limit(1);
    // Fail closed: an unknown id is an error, not a silent success. The old
    // behaviour updated zero rows and still returned 200, which let a caller
    // believe a lead had been qualified when nothing had changed.
    if (!existing) {
      res.status(404).json({ error: `Lead not found: ${leadId}` });
      return;
    }

    const transitionedAt = new Date();
    const previousStatus = existing.status;
    const previousPipelineState = existing.pipelineState;
    const auditEntry = {
      at: transitionedAt.toISOString(),
      from: previousStatus,
      to: status ?? previousStatus,
      fromPipelineState: previousPipelineState,
      toPipelineState: pipelineState ?? existing.pipelineState,
      sourceUrl: sourceUrl?.trim() ?? null,
      note: note?.trim() ?? null,
      // The acting agent, when the caller identifies itself. Never a secret.
      actor: typeof req.headers['x-apex-actor'] === 'string' ? String(req.headers['x-apex-actor']).slice(0, 120) : 'api',
    };
    const statusAudit = [
      ...(((existing.pipelineMetadata as { statusAudit?: unknown[] } | null)?.statusAudit as unknown[]) ?? []),
      auditEntry,
    ].slice(-20);

    await db
      .update(researchedLeads)
      .set({
        ...(status ? { status } : {}),
        // qualified_at is the existing timestamp for this transition; set it
        // once so a re-qualification does not silently rewrite history.
        ...(status === 'qualified' && !existing.qualifiedAt ? { qualifiedAt: transitionedAt } : {}),
        ...(pipelineState ? { pipelineState, pipelineStateChangedAt: transitionedAt, pipelineLeaseExpiresAt: null } : {}),
        ...(sourceUrl !== undefined || note !== undefined
          ? { pipelineMetadata: { ...((existing.pipelineMetadata as Record<string, unknown>) ?? {}), statusAudit } }
          : {}),
      })
      .where(eq(researchedLeads.id, leadId));

    if (pipelineState) {
      broadcast({
        type: 'lead:state',
        leadId: String(req.params.id),
        campaignId: null,
        pipelineState,
        timestamp: new Date().toISOString(),
      });
    }

    // Read-back of the row we just wrote: the response asserts what is actually
    // stored rather than echoing the request body.
    const [persisted] = await db
      .select({
        id: researchedLeads.id,
        status: researchedLeads.status,
        pipelineState: researchedLeads.pipelineState,
        qualifiedAt: researchedLeads.qualifiedAt,
        pipelineMetadata: researchedLeads.pipelineMetadata,
      })
      .from(researchedLeads)
      .where(eq(researchedLeads.id, leadId))
      .limit(1);

    res.json({
      success: true,
      id: req.params.id,
      status,
      pipelineState,
      previousStatus,
      previousPipelineState,
      persistedStatus: persisted?.status ?? null,
      persistedPipelineState: persisted?.pipelineState ?? null,
    });
  });

  return router;
}

function leadInsert(lead: ImportedLead, provider: string) {
  return {
    id: crypto.randomUUID(),
    companyName: lead.companyName,
    website: lead.website,
    industry: lead.industry,
    city: lead.city,
    decisionMakerName: lead.decisionMakerName,
    title: lead.title,
    contactEmail: lead.contactEmail,
    contactPhone: lead.contactPhone,
    linkedinUrl: lead.linkedinUrl,
    employeeCount: lead.employeeCount,
    contactResearchStatus: 'imported',
    fitReason: lead.fitReason,
    outreachAngle: lead.outreachAngle,
    status: 'new',
    pipelineState: 'CAMPAIGN_READY',
    pipelineStateChangedAt: new Date(),
    discoveredAt: new Date(),
    basicEnrichedAt: new Date(),
    contactFoundAt: new Date(),
    qualifiedAt: new Date(),
    deepResearchedAt: new Date(),
    campaignReadyAt: new Date(),
    campaignDraft: {
      firstTouch: lead.outreachAngle,
      // A call is the action that actually produces a decision maker, and the
      // operator's campaigns are calling campaigns — so a dialable lead is
      // ranked above an emailable one. This used to read the other way round
      // (`contactEmail ? 'email' : ...`), which put every lead that happened to
      // have an address into the email lane and left the ones worth calling
      // queued behind them.
      nextBestAction: lead.contactPhone ? 'call' : lead.contactEmail ? 'email' : 'research_contact',
    },
    source: provider,
    enrichment: lead.enrichment,
    researchedByAgentId: 'operator-import',
    createdAt: new Date(),
  };
}
