import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike } from 'drizzle-orm';
import { db, territoryExclusivity } from '@workspace/db';

const statusSchema = z.enum(['available', 'reserved', 'sold', 'released']);
const exclusivityTypeSchema = z.enum(['industry', 'territory']);
const geographyTypeSchema = z.enum(['zip', 'county', 'metro', 'dma', 'radius', 'custom']);

const createSchema = z.object({
  name: z.string().min(2).max(160),
  exclusivityType: exclusivityTypeSchema,
  industry: z.string().max(120).optional().nullable(),
  geographyType: geographyTypeSchema,
  geographyValue: z.string().min(1).max(240),
  geographyDefinition: z.record(z.unknown()).optional().default({}),
  status: statusSchema.optional().default('available'),
  reservedForCompany: z.string().max(200).optional().nullable(),
  reservedByLeadId: z.string().optional().nullable(),
  soldToCompany: z.string().max(200).optional().nullable(),
  ownerContact: z.string().max(200).optional().nullable(),
  effectiveAt: z.string().datetime().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const updateSchema = createSchema.partial().extend({
  status: statusSchema.optional(),
});

function toDate(value?: string | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return new Date(value);
}

export function createTerritoriesRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const conditions = [];
    if (req.query.status) conditions.push(eq(territoryExclusivity.status, String(req.query.status)));
    if (req.query.exclusivityType) conditions.push(eq(territoryExclusivity.exclusivityType, String(req.query.exclusivityType)));
    if (req.query.industry) conditions.push(ilike(territoryExclusivity.industry, `%${String(req.query.industry)}%`));
    if (req.query.geography) conditions.push(ilike(territoryExclusivity.geographyValue, `%${String(req.query.geography)}%`));

    const rows = await db
      .select()
      .from(territoryExclusivity)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(territoryExclusivity.updatedAt))
      .limit(Math.min(Number(req.query.limit) || 250, 1000));

    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({ territories: rows, byStatus });
  });

  router.post('/', async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    if (input.exclusivityType === 'industry' && !input.industry?.trim()) {
      res.status(400).json({ error: 'industry is required for industry-exclusive territories.' });
      return;
    }

    const now = new Date();
    const [row] = await db
      .insert(territoryExclusivity)
      .values({
        id: randomUUID(),
        name: input.name,
        exclusivityType: input.exclusivityType,
        industry: input.exclusivityType === 'industry' ? input.industry?.trim() : null,
        geographyType: input.geographyType,
        geographyValue: input.geographyValue.trim(),
        geographyDefinition: input.geographyDefinition,
        status: input.status,
        reservedForCompany: input.reservedForCompany ?? null,
        reservedByLeadId: input.reservedByLeadId ?? null,
        soldToCompany: input.soldToCompany ?? null,
        ownerContact: input.ownerContact ?? null,
        effectiveAt: toDate(input.effectiveAt) ?? null,
        expiresAt: toDate(input.expiresAt) ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.status(201).json({ territory: row });
  });

  router.patch('/:id', async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    const [existing] = await db
      .select()
      .from(territoryExclusivity)
      .where(eq(territoryExclusivity.id, req.params.id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: 'Territory not found' });
      return;
    }

    const nextType = input.exclusivityType ?? existing.exclusivityType;
    const nextIndustry = input.industry === undefined ? existing.industry : input.industry;
    if (nextType === 'industry' && !nextIndustry?.trim()) {
      res.status(400).json({ error: 'industry is required for industry-exclusive territories.' });
      return;
    }

    const [row] = await db
      .update(territoryExclusivity)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.exclusivityType !== undefined ? { exclusivityType: input.exclusivityType } : {}),
        ...(input.industry !== undefined ? { industry: nextType === 'industry' ? input.industry?.trim() ?? null : null } : {}),
        ...(input.geographyType !== undefined ? { geographyType: input.geographyType } : {}),
        ...(input.geographyValue !== undefined ? { geographyValue: input.geographyValue.trim() } : {}),
        ...(input.geographyDefinition !== undefined ? { geographyDefinition: input.geographyDefinition } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.reservedForCompany !== undefined ? { reservedForCompany: input.reservedForCompany ?? null } : {}),
        ...(input.reservedByLeadId !== undefined ? { reservedByLeadId: input.reservedByLeadId ?? null } : {}),
        ...(input.soldToCompany !== undefined ? { soldToCompany: input.soldToCompany ?? null } : {}),
        ...(input.ownerContact !== undefined ? { ownerContact: input.ownerContact ?? null } : {}),
        ...(input.effectiveAt !== undefined ? { effectiveAt: toDate(input.effectiveAt) ?? null } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: toDate(input.expiresAt) ?? null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(territoryExclusivity.id, req.params.id))
      .returning();

    res.json({ territory: row });
  });

  return router;
}
