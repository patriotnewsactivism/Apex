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
      conditions.push(sql`(
        ${researchedLeads.source} IS NULL
        OR ${researchedLeads.source} NOT LIKE '%web:%'
        OR ${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'
      )`);
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
  router.get('/export', async (_req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');

    const leads = await db
      .select()
      .from(researchedLeads)
      .where(and(
        sql`${researchedLeads.status} <> 'rejected'`,
        sql`(${researchedLeads.contactEmail} IS NOT NULL OR ${researchedLeads.contactPhone} IS NOT NULL)`,
        sql`(
          ${researchedLeads.source} IS NULL
          OR ${researchedLeads.source} NOT LIKE '%web:%'
          OR ${researchedLeads.enrichment}->'businessVerification'->>'status' = 'verified'
        )`,
      ))
      .orderBy(desc(researchedLeads.createdAt))
      .limit(10000);

    const escapeCsv = (val: string | null | undefined): string => {
      if (val == null) return '';
      const needsQuoting = /["\n\r,]/.test(val);
      const escaped = val.replace(/"/g, '""');
      return needsQuoting ? `"${escaped}"` : escaped;
    };

    const headers = [
      'Company Name', 'Website', 'Industry', 'City', 'Decision Maker', 'Email', 'Phone', 'Contact Source', 'Contact Research Status', 'Status',
      'Fit Reason', 'Outreach Angle', 'Enrichment Data', 'Researched By', 'Created At',
    ];

    const rows = leads.map((l) => [
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
      const isWeb = /^(?:cache:)?web:/i.test(lead.source ?? '');
      if (!isWeb) return true;
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

  // ─── PATCH /api/leads/:id — update status ────────────────────────────────
  router.patch('/:id', async (req, res) => {
    const { db, researchedLeads } = await import('@workspace/db');
    const { status, pipelineState } = req.body as { status?: string; pipelineState?: string };
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

    await db
      .update(researchedLeads)
      .set({
        ...(status ? { status } : {}),
        ...(pipelineState ? { pipelineState, pipelineStateChangedAt: new Date(), pipelineLeaseExpiresAt: null } : {}),
      })
      .where(eq(researchedLeads.id, String(req.params.id)));

    if (pipelineState) {
      broadcast({
        type: 'lead:state',
        leadId: String(req.params.id),
        campaignId: null,
        pipelineState,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ success: true, id: req.params.id, status, pipelineState });
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
      nextBestAction: lead.contactEmail ? 'email' : lead.contactPhone ? 'call' : 'research_contact',
    },
    source: provider,
    enrichment: lead.enrichment,
    researchedByAgentId: 'operator-import',
    createdAt: new Date(),
  };
}
