/**
 * Read-only CRM tools. Agents can search and read history.
 * They cannot edit timelines, clear do-not-contact, or merge contacts.
 */
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { getContact, getTimeline, searchContacts } from './store.js';

const searchSchema = z.object({
  query: z.string().optional(),
  tag: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  doNotContact: z.boolean().optional(),
  ownerBot: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const contactIdSchema = z.object({ contactId: z.string().uuid() });

export function createCrmTools(): ToolDefinition[] {
  const search: ToolDefinition = {
    name: 'crm_search_contacts',
    description: 'Search the CRM contact book by name, organization, email, phone, tag, notes, or message text. Read-only.',
    schema: searchSchema,
    requiresApproval: false,
    async execute(input) {
      const parsed = searchSchema.parse(input);
      const rows = await searchContacts({
        query: parsed.query,
        tag: parsed.tag,
        city: parsed.city,
        state: parsed.state,
        doNotContact: parsed.doNotContact,
        ownerBot: parsed.ownerBot,
        limit: parsed.limit ?? 20,
      });
      return {
        contacts: rows.map((row) => ({
          id: row.id,
          name: [row.firstName, row.lastName].filter(Boolean).join(' '),
          organization: row.organizationName,
          email: row.email,
          phone: row.phoneE164,
          city: row.city,
          state: row.state,
          tags: row.tags,
          doNotContact: row.doNotContact,
          ownerBot: row.ownerBot,
          lastContactedAt: row.lastContactedAt,
          lastReplyAt: row.lastReplyAt,
        })),
      };
    },
  };

  const getOne: ToolDefinition = {
    name: 'crm_get_contact',
    description: 'Read one CRM contact profile, identifiers, and meetings. Read-only. Does not change do-not-contact.',
    schema: contactIdSchema,
    requiresApproval: false,
    async execute(input) {
      const parsed = contactIdSchema.parse(input);
      const found = await getContact(parsed.contactId);
      if (!found) return { found: false };
      return { found: true, ...found };
    },
  };

  const timeline: ToolDefinition = {
    name: 'crm_get_timeline',
    description: 'Read the append-only timeline for a contact, including timelines kept after a merge. Read-only. Rows cannot be edited.',
    schema: contactIdSchema,
    requiresApproval: false,
    async execute(input) {
      const parsed = contactIdSchema.parse(input);
      const rows = await getTimeline(parsed.contactId);
      return {
        events: rows.map((row) => ({
          id: row.id,
          occurredAt: row.occurredAt,
          channel: row.channel,
          direction: row.direction,
          actorName: row.actorName,
          eventKind: row.eventKind,
          subject: row.subject,
          bodyText: row.bodyText,
          provider: row.provider,
          providerMessageId: row.providerMessageId,
        })),
      };
    },
  };

  return [search, getOne, timeline];
}
