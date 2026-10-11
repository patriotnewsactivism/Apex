/**
 * CRM phase 3: saved views — a named filter set, so a working view reopens in
 * one click instead of being rebuilt by hand.
 *
 * A view stores filters only. It cannot store a permission, and it does not
 * change what the operator can do once it is applied: applying one is the same
 * as typing the filters yourself.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { auditEvents, crmSavedViews, db } from '@workspace/db';
import { CRM_ORGANIZATION_ID } from './pure.js';
import { CrmWriteError } from './operator.js';

export const SAVED_VIEW_SCOPES = ['contacts', 'leads', 'deals', 'companies'] as const;
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number];

export interface SavedView {
  id: string;
  name: string;
  scope: string;
  filters: Record<string, unknown>;
  pinned: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanFilters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // Only scalars and the two filter-shaped arrays the UI can produce; a view
    // must not smuggle an object that means something else on the way back.
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[key] = raw;
  }
  return out;
}

export async function listSavedViews(input: { scope?: string | null } = {}): Promise<SavedView[]> {
  const clauses = [eq(crmSavedViews.organizationId, CRM_ORGANIZATION_ID)];
  if (input.scope && (SAVED_VIEW_SCOPES as readonly string[]).includes(input.scope)) {
    clauses.push(eq(crmSavedViews.scope, input.scope));
  }
  const rows = await db
    .select()
    .from(crmSavedViews)
    .where(and(...clauses))
    .orderBy(desc(crmSavedViews.pinned), asc(crmSavedViews.name))
    .limit(200);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    filters: (row.filters ?? {}) as Record<string, unknown>,
    pinned: row.pinned,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/** Save (or overwrite by name) the filters currently in the view. */
export async function saveView(input: {
  actor: string;
  name?: unknown;
  scope?: unknown;
  filters?: unknown;
  pinned?: unknown;
}): Promise<{ viewId: string; created: boolean }> {
  const name = clean(input.name);
  if (!name) throw new CrmWriteError('A saved view needs a name.');
  if (name.length > 80) throw new CrmWriteError('That name is too long; keep it under 80 characters.');
  const scope = (clean(input.scope) ?? 'contacts') as string;
  if (!(SAVED_VIEW_SCOPES as readonly string[]).includes(scope)) {
    throw new CrmWriteError(`Unknown scope "${scope}". Use one of ${SAVED_VIEW_SCOPES.join(', ')}.`);
  }
  const filters = cleanFilters(input.filters);
  const at = new Date();
  const [existing] = await db
    .select({ id: crmSavedViews.id })
    .from(crmSavedViews)
    .where(and(
      eq(crmSavedViews.organizationId, CRM_ORGANIZATION_ID),
      eq(crmSavedViews.scope, scope),
      sql`lower(${crmSavedViews.name}) = ${name.toLowerCase()}`,
    ))
    .limit(1);
  const viewId = await db.transaction(async (tx) => {
    const executor = tx as unknown as typeof db;
    if (existing) {
      await executor.update(crmSavedViews).set({
        filters,
        pinned: input.pinned === true,
        updatedAt: at,
      }).where(eq(crmSavedViews.id, existing.id));
      await executor.insert(auditEvents).values({
        organizationId: CRM_ORGANIZATION_ID,
        actorType: 'user',
        actorId: input.actor,
        action: 'crm_view.updated',
        entityType: 'crm_saved_view',
        entityId: existing.id,
        metadata: { name, scope, filters },
      });
      return existing.id;
    }
    const [created] = await executor.insert(crmSavedViews).values({
      organizationId: CRM_ORGANIZATION_ID,
      name,
      scope,
      filters,
      pinned: input.pinned === true,
      createdBy: input.actor,
    }).returning({ id: crmSavedViews.id });
    if (!created) throw new CrmWriteError('Saved view insert returned no id');
    await executor.insert(auditEvents).values({
      organizationId: CRM_ORGANIZATION_ID,
      actorType: 'user',
      actorId: input.actor,
      action: 'crm_view.created',
      entityType: 'crm_saved_view',
      entityId: created.id,
      metadata: { name, scope, filters },
    });
    return created.id;
  });
  return { viewId: viewId ?? '', created: !existing };
}

export async function deleteSavedView(input: { viewId: string; actor: string }): Promise<{ ok: true }> {
  const [existing] = await db
    .select({ id: crmSavedViews.id, name: crmSavedViews.name, scope: crmSavedViews.scope })
    .from(crmSavedViews)
    .where(and(eq(crmSavedViews.id, input.viewId), eq(crmSavedViews.organizationId, CRM_ORGANIZATION_ID)))
    .limit(1);
  if (!existing) throw new CrmWriteError('That saved view was not found.');
  await db.transaction(async (tx) => {
    const executor = tx as unknown as typeof db;
    await executor.delete(crmSavedViews).where(eq(crmSavedViews.id, input.viewId));
    await executor.insert(auditEvents).values({
      organizationId: CRM_ORGANIZATION_ID,
      actorType: 'user',
      actorId: input.actor,
      action: 'crm_view.deleted',
      entityType: 'crm_saved_view',
      entityId: input.viewId,
      metadata: { name: existing.name, scope: existing.scope },
    });
  });
  return { ok: true };
}