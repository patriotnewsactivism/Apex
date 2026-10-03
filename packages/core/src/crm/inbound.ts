/**
 * Inbound email matching: reply token, then In-Reply-To/References, then sender.
 * Unmatched mail is queued. A matched reply pauses follow-ups.
 */
import { eq, sql } from 'drizzle-orm';
import { contactIdentifiers, contactTimeline, contacts, db, inboundUnmatched } from '@workspace/db';
import { artifactAttachmentStorage, type AttachmentStorage, type StoredAttachment } from './attachments.js';
import {
  CRM_ORGANIZATION_ID,
  applyDoNotContact,
  asExecutor,
  insertTimelineEvent,
} from './store.js';
import {
  bccCaptureAddress,
  extractEmailAddress,
  extractEmailAddresses,
  isBccCaptureRecipient,
  isOptOutMessage,
  matchInboundEmail,
  type InboundMatchIndex,
} from './pure.js';

export interface InboundEmailAttachment {
  filename: string;
  contentType: string;
  sizeBytes?: number;
  contentBase64?: string;
}

export interface InboundEmail {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  providerMessageId?: string | null;
  attachments?: InboundEmailAttachment[];
}

export interface InboundEmailResult {
  matched: boolean;
  basis?: 'token' | 'headers' | 'sender' | 'bcc';
  contactId?: string;
  timelineId?: string;
  unmatchedId?: string;
  doNotContact?: boolean;
}

async function loadMatchIndex(): Promise<InboundMatchIndex> {
  const tokens = new Map<string, string>();
  const messageIds = new Map<string, string>();
  const emails = new Map<string, string>();
  const tokenRows = await db
    .select({ token: contactTimeline.replyToken, contactId: contactTimeline.contactId })
    .from(contactTimeline)
    .where(sql`${contactTimeline.replyToken} IS NOT NULL AND ${contactTimeline.contactId} IS NOT NULL`);
  for (const row of tokenRows) {
    if (row.token && row.contactId) tokens.set(row.token, row.contactId);
  }
  const idRows = await db
    .select({ messageId: contactTimeline.emailMessageId, contactId: contactTimeline.contactId })
    .from(contactTimeline)
    .where(sql`${contactTimeline.emailMessageId} IS NOT NULL AND ${contactTimeline.contactId} IS NOT NULL`);
  for (const row of idRows) {
    if (row.messageId && row.contactId) {
      messageIds.set(row.messageId, row.contactId);
      messageIds.set(row.messageId.toLowerCase(), row.contactId);
    }
  }
  const contactRows = await db.select({ id: contacts.id, email: contacts.email }).from(contacts).where(sql`${contacts.email} IS NOT NULL`);
  for (const row of contactRows) {
    if (row.email) emails.set(row.email.toLowerCase(), row.id);
  }
  const identRows = await db.select({
    contactId: contactIdentifiers.contactId,
    value: contactIdentifiers.value,
  }).from(contactIdentifiers).where(eq(contactIdentifiers.kind, 'email'));
  for (const row of identRows) emails.set(row.value.toLowerCase(), row.contactId);
  return { tokens, messageIds, emails };
}

async function storeAttachments(
  attachments: InboundEmailAttachment[] | undefined,
  storage: AttachmentStorage,
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const bytes = attachment.contentBase64 ? Buffer.from(attachment.contentBase64, 'base64') : Buffer.alloc(0);
    if (!attachment.contentBase64) {
      stored.push({
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes ?? 0,
        storageKey: `unconfigured/${attachment.filename}`,
      });
      continue;
    }
    stored.push(await storage.put({
      filename: attachment.filename,
      contentType: attachment.contentType || 'application/octet-stream',
      bytes,
    }));
  }
  return stored;
}

export async function ingestInboundEmail(
  email: InboundEmail,
  options: { storage?: AttachmentStorage } = {},
): Promise<InboundEmailResult> {
  const storage = options.storage ?? artifactAttachmentStorage();
  const fromEmail = extractEmailAddress(email.from);
  const recipients = [
    ...extractEmailAddresses(email.to),
    ...extractEmailAddresses(email.cc),
    ...extractEmailAddresses(email.bcc),
  ];
  const attachments = await storeAttachments(email.attachments, storage);
  const index = await loadMatchIndex();
  const bcc = isBccCaptureRecipient(recipients);
  let contactId: string | null = null;
  let basis: InboundEmailResult['basis'];
  if (bcc) {
    const capture = bccCaptureAddress();
    for (const recipient of recipients) {
      if (capture && recipient === capture) continue;
      const found = index.emails.get(recipient);
      if (found) {
        contactId = found;
        basis = 'bcc';
        break;
      }
    }
  } else {
    const match = matchInboundEmail({
      recipients,
      fromEmail,
      inReplyTo: email.inReplyTo ?? null,
      references: email.references ?? null,
    }, index);
    if (match.matched) {
      contactId = match.contactId;
      basis = match.basis;
    }
  }

  const optOut = isOptOutMessage(email.text ?? email.subject ?? '');
  if (!contactId) {
    const [queued] = await db.insert(inboundUnmatched).values({
      organizationId: CRM_ORGANIZATION_ID,
      channel: 'email',
      fromAddress: fromEmail,
      toAddresses: recipients,
      subject: email.subject ?? null,
      bodyText: email.text ?? null,
      bodyHtml: email.html ?? null,
      emailMessageId: email.messageId ?? null,
      inReplyTo: email.inReplyTo ?? null,
      referencesHeader: email.references ?? null,
      providerMessageId: email.providerMessageId ?? null,
      attachments,
      status: 'unmatched',
    }).returning({ id: inboundUnmatched.id });
    return { matched: false, unmatchedId: queued?.id };
  }

  const direction = bcc ? 'outbound' as const : 'inbound' as const;
  const actorName = bcc ? 'Matthew' : (fromEmail ?? 'unknown');
  const recorded = await db.transaction(async (tx) => {
    const executor = asExecutor(tx);
    const row = await insertTimelineEvent(executor, {
      contactId,
      destination: fromEmail,
      createContact: false,
      channel: 'email',
      direction,
      actorType: bcc ? 'operator' : 'system',
      actorName,
      eventKind: bcc ? 'email' : 'reply',
      subject: email.subject ?? null,
      bodyText: email.text ?? null,
      bodyHtml: email.html ?? null,
      provider: 'resend',
      providerMessageId: email.providerMessageId ?? null,
      emailMessageId: email.messageId ?? null,
      inReplyTo: email.inReplyTo ?? null,
      referencesHeader: email.references ?? null,
      attachments,
    });
    if (!bcc && optOut.matched) {
      await applyDoNotContact(executor, {
        contactId,
        destination: fromEmail,
        reason: optOut.phrase ?? 'opt-out reply',
        setBy: 'inbound-email',
        channel: 'email',
      });
    }
    return row.id;
  });
  return { matched: true, basis, contactId, timelineId: recorded, doNotContact: !bcc && optOut.matched };
}

export { matchInboundEmail };
