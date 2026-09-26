// Pure lead-import planning. The route loads existing rows and writes; this
// module only parses, maps, and decides new vs update vs skip.

export interface ImportedLead {
  companyName: string;
  website: string | null;
  industry: string | null;
  city: string | null;
  decisionMakerName: string | null;
  title: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  linkedinUrl: string | null;
  employeeCount: number | null;
  outreachAngle: string | null;
  fitReason: string;
  source: string;
  enrichment: Record<string, string>;
}

export interface ExistingLeadSnapshot {
  id: string;
  contactEmail: string | null;
  website: string | null;
  decisionMakerName: string | null;
  contactPhone: string | null;
  title: string | null;
  linkedinUrl: string | null;
  employeeCount: number | null;
  outreachAngle: string | null;
  enrichment: Record<string, unknown> | null;
}

export interface ImportPlanRow {
  action: 'new' | 'update' | 'skip';
  reason: string;
  existingId?: string;
  lead: ImportedLead;
}

export interface ImportPlan {
  rows: ImportPlanRow[];
  preview: ImportPlanRow[];
  counts: { created: number; updated: number; skipped: number };
}

const FIELD_ALIASES: Record<keyof Omit<ImportedLead, 'enrichment' | 'fitReason' | 'source'>, string[]> = {
  companyName: ['company', 'company name', 'organization', 'account name', 'business', 'business name', 'account'],
  website: ['website', 'domain', 'company domain', 'url', 'company website'],
  industry: ['industry', 'vertical'],
  city: ['city', 'location', 'company city'],
  decisionMakerName: ['decision maker', 'contact name', 'full name', 'name', 'person name'],
  title: ['title', 'job title', 'position'],
  contactEmail: ['email', 'contact email', 'work email', 'email address', 'person email'],
  contactPhone: ['phone', 'mobile', 'direct phone', 'phone number', 'mobile phone', 'contact phone'],
  linkedinUrl: ['linkedin', 'linkedin url', 'person linkedin url', 'linkedin profile'],
  employeeCount: ['employees', 'employee count', '# employees', 'company size', 'employee_count'],
  outreachAngle: ['outreach angle', 'angle', 'personalization', 'icebreaker'],
};

const FIRST_NAME_ALIASES = ['first name', 'firstname', 'first'];
const LAST_NAME_ALIASES = ['last name', 'lastname', 'last'];

function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
}

export function normalizeWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
}

export function normalizeImportEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeImportPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(compact)) return null;
  return compact.startsWith('+') ? compact : `+${compact}`;
}

function lookupHeader(headers: string[], aliases: string[]): number {
  const keys = headers.map(headerKey);
  for (const alias of aliases) {
    const index = keys.indexOf(alias);
    if (index >= 0) return index;
  }
  return -1;
}

function cell(row: string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

export function mapImportRows(
  records: Array<Record<string, string>>,
  provider: string,
): { leads: ImportedLead[]; skipped: Array<{ reason: string; lead: ImportedLead | null }> } {
  const leads: ImportedLead[] = [];
  const skipped: Array<{ reason: string; lead: ImportedLead | null }> = [];
  const source = provider.trim() || 'import';

  for (const record of records) {
    const entries = Object.entries(record);
    const headers = entries.map(([key]) => key);
    const values = entries.map(([, value]) => value ?? '');
    const take = (aliases: string[]) => cell(values, lookupHeader(headers, aliases));
    const first = take(FIRST_NAME_ALIASES);
    const last = take(LAST_NAME_ALIASES);
    const named = take(FIELD_ALIASES.decisionMakerName);
    const decisionMakerName = named || [first, last].filter(Boolean).join(' ') || null;
    const employeeRaw = take(FIELD_ALIASES.employeeCount).replace(/,/g, '');
    const employeeCount = /^\d+$/.test(employeeRaw) ? Number(employeeRaw) : null;
    const known = new Set<number>();
    for (const aliases of [...Object.values(FIELD_ALIASES), FIRST_NAME_ALIASES, LAST_NAME_ALIASES]) {
      const index = lookupHeader(headers, aliases);
      if (index >= 0) known.add(index);
    }
    const enrichment: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (known.has(index)) return;
      const value = values[index]?.trim();
      if (value) enrichment[header.trim()] = value;
    });
    const companyName = take(FIELD_ALIASES.companyName);
    const contactEmail = normalizeImportEmail(take(FIELD_ALIASES.contactEmail));
    const contactPhone = normalizeImportPhone(take(FIELD_ALIASES.contactPhone));
    const lead: ImportedLead = {
      companyName,
      website: normalizeWebsite(take(FIELD_ALIASES.website)),
      industry: take(FIELD_ALIASES.industry) || null,
      city: take(FIELD_ALIASES.city) || null,
      decisionMakerName,
      title: take(FIELD_ALIASES.title) || null,
      contactEmail,
      contactPhone,
      linkedinUrl: take(FIELD_ALIASES.linkedinUrl) || null,
      employeeCount,
      outreachAngle: take(FIELD_ALIASES.outreachAngle) || null,
      fitReason: `Imported from ${source}.`,
      source,
      enrichment,
    };
    if (!companyName) {
      skipped.push({ reason: 'missing company name', lead });
      continue;
    }
    if (!contactEmail && !contactPhone) {
      skipped.push({ reason: 'missing both email and phone', lead });
      continue;
    }
    leads.push(lead);
  }
  return { leads, skipped };
}

export function recordsFromCsv(csv: string): Array<Record<string, string>> {
  const table = parseCsv(csv);
  if (table.length < 2) return [];
  const headers = table[0].map((header) => header.trim());
  return table.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index] ?? '';
    });
    return record;
  });
}

function prefer(incoming: string | null, current: string | null, overwrite: boolean): string | null {
  if (!incoming) return current;
  if (overwrite || !current) return incoming;
  return current;
}

export function planLeadImport(input: {
  leads: ImportedLead[];
  existing: ExistingLeadSnapshot[];
  overwrite: boolean;
  parseSkips?: Array<{ reason: string; lead: ImportedLead | null }>;
}): ImportPlan {
  const byEmail = new Map<string, ExistingLeadSnapshot>();
  const bySite = new Map<string, ExistingLeadSnapshot>();
  for (const row of input.existing) {
    const email = normalizeImportEmail(row.contactEmail);
    const site = normalizeWebsite(row.website);
    if (email && !byEmail.has(email)) byEmail.set(email, row);
    if (site && !bySite.has(site)) bySite.set(site, row);
  }

  const seenEmail = new Set<string>();
  const seenSite = new Set<string>();
  const rows: ImportPlanRow[] = [];

  for (const skip of input.parseSkips ?? []) {
    if (!skip.lead) continue;
    rows.push({ action: 'skip', reason: skip.reason, lead: skip.lead });
  }

  for (const lead of input.leads) {
    const email = lead.contactEmail;
    const site = lead.website;
    if ((email && seenEmail.has(email)) || (site && !email && seenSite.has(site))) {
      rows.push({ action: 'skip', reason: 'duplicate inside the file', lead });
      continue;
    }
    if (email) seenEmail.add(email);
    if (site) seenSite.add(site);

    const existing = (email && byEmail.get(email)) || (site && bySite.get(site)) || undefined;
    if (!existing) {
      rows.push({ action: 'new', reason: 'no matching email or website', lead });
      continue;
    }

    const merged: ImportedLead = {
      ...lead,
      decisionMakerName: prefer(lead.decisionMakerName, existing.decisionMakerName, input.overwrite),
      contactPhone: prefer(lead.contactPhone, existing.contactPhone, input.overwrite),
      title: prefer(lead.title, existing.title, input.overwrite),
      linkedinUrl: prefer(lead.linkedinUrl, existing.linkedinUrl, input.overwrite),
      employeeCount: lead.employeeCount ?? existing.employeeCount,
      outreachAngle: prefer(lead.outreachAngle, existing.outreachAngle, input.overwrite),
      enrichment: {
        ...(existing.enrichment && typeof existing.enrichment === 'object' ? Object.fromEntries(
          Object.entries(existing.enrichment).map(([key, value]) => [key, String(value)]),
        ) : {}),
        ...lead.enrichment,
      },
    };
    const changed = merged.decisionMakerName !== existing.decisionMakerName
      || merged.contactPhone !== existing.contactPhone
      || merged.title !== existing.title
      || merged.linkedinUrl !== existing.linkedinUrl
      || merged.employeeCount !== existing.employeeCount
      || merged.outreachAngle !== existing.outreachAngle
      || Object.keys(lead.enrichment).length > 0
      || (lead.contactEmail && !existing.contactEmail);
    rows.push(changed
      ? { action: 'update', reason: 'matched an existing lead', existingId: existing.id, lead: merged }
      : { action: 'skip', reason: 'already on file with the same contact fields', existingId: existing.id, lead: merged });
  }

  const counts = {
    created: rows.filter((row) => row.action === 'new').length,
    updated: rows.filter((row) => row.action === 'update').length,
    skipped: rows.filter((row) => row.action === 'skip').length,
  };
  return { rows, preview: rows.slice(0, 20), counts };
}
