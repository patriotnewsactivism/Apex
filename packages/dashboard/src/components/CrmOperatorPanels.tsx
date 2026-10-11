/**
 * The CRM phase 1 panels: the things the operator does by hand.
 *
 * Client status, editing a contact, notes and tags, logging a call you made
 * yourself, follow-up tasks with a due-today list, copying researched leads
 * into the contact book, and lifting a single recorded opt-out.
 *
 * Every write goes through the operator-authenticated routes, so a privileged
 * action (status, opt-out lift, the lead copy) needs the dashboard session
 * minted at password login; without it the server says so and the panel shows
 * that message rather than pretending the change landed.
 */
import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  CRM_LIFECYCLE_STAGES,
  type CrmContact,
  type CrmLeadImportFilters,
  type CrmLeadImportPreview,
  type CrmLifecycleStage,
  type CrmTask,
} from '../lib/api.js';

const wrap: CSSProperties = {
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
  maxWidth: '100%',
};

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const label: CSSProperties = { fontSize: 12, color: 'var(--color-apex-muted)' };
const inputStyle: CSSProperties = { flex: '1 1 140px', minWidth: 0 };
const buttonStyle: CSSProperties = { padding: '6px 10px' };

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function contactName(row: { firstName: string | null; lastName: string | null; organizationName: string | null; email: string | null }): string {
  const person = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return person || row.organizationName || row.email || 'Unnamed contact';
}

const STAGE_COLORS: Record<string, string> = {
  prospect: '#8a8f98',
  lead: '#4a9ec9',
  qualified: '#c9a84a',
  client: '#5fae7f',
  churned: '#c45c66',
};

export function LifecycleBadge({ stage }: { stage: string | null | undefined }) {
  if (!stage) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        color: STAGE_COLORS[stage] ?? '#8a8f98',
        border: `1px solid ${STAGE_COLORS[stage] ?? '#8a8f98'}`,
      }}
    >
      {stage}
    </span>
  );
}

// ─── Due today ───────────────────────────────────────────────────────────────

/**
 * The list you open in the morning: open follow-ups due before the end of today
 * in Chicago, overdue ones included and marked.
 */
export function DueTodayPanel({ onOpenContact }: { onOpenContact?: (contactId: string) => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const due = useQuery({ queryKey: ['crm-tasks-due'], queryFn: () => api.crm.tasks.due() });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['crm-tasks-due'] });
    queryClient.invalidateQueries({ queryKey: ['crm-tasks'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contacts'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contact'] });
  };
  const done = useMutation({
    mutationFn: (id: string) => api.crm.tasks.complete(id),
    onSuccess: () => { setNotice('Follow-up marked done.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not complete the follow-up.'),
  });
  const tomorrow = useMutation({
    mutationFn: (id: string) => api.crm.tasks.reschedule(id, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
    onSuccess: () => { setNotice('Moved to tomorrow.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not reschedule the follow-up.'),
  });
  const drop = useMutation({
    mutationFn: (id: string) => api.crm.tasks.cancel(id, 'dropped from the due list'),
    onSuccess: () => { setNotice('Follow-up cancelled.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not cancel the follow-up.'),
  });

  const tasks = due.data?.tasks ?? [];
  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Due today</div>
        <span style={label}>
          {due.data ? `${tasks.length} open follow-up${tasks.length === 1 ? '' : 's'} due${due.data.date ? ` ${due.data.date}` : ''}` : 'loading'}
        </span>
      </div>
      {tasks.length === 0 && !due.isLoading && <div style={{ ...label }}>Nothing due today.</div>}
      {tasks.map((task) => (
        <div key={task.id} style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 8 }}>
          <div style={{ ...wrap, flex: '1 1 220px' }}>
            <div style={{ fontWeight: 650 }}>{task.title}</div>
            <div style={label}>
              {[
                task.contactName ? contactName({ firstName: task.contactName, lastName: null, organizationName: task.contactOrganization, email: null }) : null,
                task.dueChicago ? `due ${task.dueChicago}` : null,
                task.overdue ? 'overdue' : null,
                task.priority !== 'normal' ? task.priority : null,
              ].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div style={row}>
            {task.contactId && onOpenContact && (
              <button type="button" style={buttonStyle} onClick={() => onOpenContact(task.contactId!)}>Open contact</button>
            )}
            <button type="button" style={buttonStyle} onClick={() => done.mutate(task.id)}>Done</button>
            <button type="button" style={buttonStyle} onClick={() => tomorrow.mutate(task.id)}>Tomorrow</button>
            <button type="button" style={buttonStyle} onClick={() => drop.mutate(task.id)}>Cancel</button>
          </div>
        </div>
      ))}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Client status ───────────────────────────────────────────────────────────

/**
 * Move a contact along prospect → lead → qualified → client → churned. The
 * server refuses anyone but the operator, so a panel open on a machine without
 * the dashboard session gets that refusal and shows it.
 */
export function ContactStatusControl({ contact, onChanged }: { contact: CrmContact; onChanged?: () => void }) {
  const [stage, setStage] = useState<string>(contact.lifecycleStage ?? 'prospect');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const move = useMutation({
    mutationFn: () => api.crm.setLifecycle(contact.id, stage as CrmLifecycleStage, reason || undefined),
    onSuccess: (result) => {
      setNotice(result.changed ? `Client status: ${result.from} → ${result.to}.` : `Already ${result.to}.`);
      setReason('');
      onChanged?.();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not change the client status.'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Client status</div>
        <LifecycleBadge stage={contact.lifecycleStage} />
      </div>
      <div style={row}>
        <select
          data-copilot-target="contact-lifecycle"
          aria-label="Client status"
          value={stage}
          onChange={(event) => setStage(event.target.value)}
          style={inputStyle}
        >
          {CRM_LIFECYCLE_STAGES.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <input
          aria-label="Why the status changed"
          placeholder="Why (optional)"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          style={inputStyle}
        />
        <button type="button" style={buttonStyle} disabled={move.isPending} onClick={() => move.mutate()}>
          Move status
        </button>
      </div>
      {contact.lifecycleStageChangedAt && (
        <div style={label}>Last moved by {contact.lifecycleStageChangedBy ?? 'unknown'} on {new Date(contact.lifecycleStageChangedAt).toLocaleDateString()}</div>
      )}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Edit a contact ──────────────────────────────────────────────────────────

const EDIT_FIELDS: Array<{ key: keyof CrmContact & string; label: string }> = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'organizationName', label: 'Organization' },
  { key: 'title', label: 'Title' },
  { key: 'email', label: 'Email' },
  { key: 'phoneE164', label: 'Phone' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'website', label: 'Website' },
  { key: 'ownerBot', label: 'Owner bot' },
];

export function ContactEditForm({ contact, onSaved }: { contact: CrmContact; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of EDIT_FIELDS) initial[field.key] = (contact[field.key] as string | null) ?? '';
    initial.notes = contact.notes ?? '';
    return initial;
  });
  const [notice, setNotice] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      for (const field of EDIT_FIELDS) {
        const next = (draft[field.key] ?? '').trim();
        const current = ((contact[field.key] as string | null) ?? '').trim();
        if (next !== current) patch[field.key === 'phoneE164' ? 'phone' : field.key] = next === '' ? null : next;
      }
      const notes = (draft.notes ?? '').trim();
      if (notes !== (contact.notes ?? '').trim()) patch.notes = notes === '' ? null : notes;
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change.');
      return api.crm.updateContact(contact.id, patch);
    },
    onSuccess: (result) => { setNotice(`Saved: ${result.changed.join(', ')}.`); onSaved?.(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not save the contact.'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Edit this contact</div>
        <button type="button" style={buttonStyle} onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'Open'}</button>
      </div>
      {open && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EDIT_FIELDS.map((field) => (
              <input
                key={field.key}
                aria-label={field.label}
                placeholder={field.label}
                value={draft[field.key] ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                style={inputStyle}
              />
            ))}
          </div>
          <textarea
            aria-label="Notes"
            placeholder="Notes"
            value={draft.notes ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
          <div style={row}>
            <button type="button" className="btn-primary" style={buttonStyle} disabled={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </button>
            <span style={label}>Every edit is written to the contact history.</span>
          </div>
        </>
      )}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

export function TagEditor({ contact, onChanged }: { contact: CrmContact; onChanged?: () => void }) {
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const tags = contact.tags ?? [];

  const update = useMutation({
    mutationFn: (body: { add?: string[]; remove?: string[] }) => api.crm.setTags(contact.id, body),
    onSuccess: () => { setValue(''); setNotice('Tags updated.'); onChanged?.(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not update the tags.'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Tags</div>
      <div style={row}>
        {tags.length === 0 && <span style={label}>No tags.</span>}
        {tags.map((tag) => (
          <span key={tag} style={{ ...row, gap: 4, fontSize: 12, border: '1px solid rgba(255,255,255,0.18)', borderRadius: 4, padding: '2px 6px' }}>
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => update.mutate({ remove: [tag] })}
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div style={row}>
        <input aria-label="New tag" placeholder="Add a tag" value={value} onChange={(event) => setValue(event.target.value)} style={inputStyle} />
        <button
          type="button"
          style={buttonStyle}
          disabled={!value.trim() || update.isPending}
          onClick={() => update.mutate({ add: value.split(',').map((tag) => tag.trim()).filter(Boolean) })}
        >
          Add tag
        </button>
      </div>
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Calls you made yourself ─────────────────────────────────────────────────

export function LogCallForm({ contactId, onLogged }: { contactId: string; onLogged?: () => void }) {
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const log = useMutation({
    mutationFn: () => api.crm.logCall(contactId, {
      direction,
      outcome: outcome || undefined,
      notes: notes || undefined,
      occurredAt: toIso(when),
      durationSeconds: minutes ? Math.round(Number(minutes) * 60) : undefined,
    }),
    onSuccess: () => { setNotice('Call written to the history.'); setOutcome(''); setNotes(''); setMinutes(''); onLogged?.(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not log the call.'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Log a call you made yourself</div>
      <div style={row}>
        <select aria-label="Call direction" value={direction} onChange={(event) => setDirection(event.target.value as 'outbound' | 'inbound')} style={inputStyle}>
          <option value="outbound">I called them</option>
          <option value="inbound">They called me</option>
        </select>
        <input aria-label="Outcome" placeholder="Outcome (spoke to owner, voicemail…)" value={outcome} onChange={(event) => setOutcome(event.target.value)} style={inputStyle} />
        <input aria-label="When" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} style={inputStyle} />
        <input aria-label="Minutes" placeholder="Minutes" value={minutes} onChange={(event) => setMinutes(event.target.value)} style={inputStyle} />
      </div>
      <textarea
        aria-label="Call notes"
        placeholder="What was said"
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        rows={2}
        style={{ width: '100%', boxSizing: 'border-box' }}
      />
      <div style={row}>
        <button type="button" style={buttonStyle} disabled={log.isPending} onClick={() => log.mutate()}>Log call</button>
        <span style={label}>No provider call is placed. This writes the history row.</span>
      </div>
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Follow-up tasks on a contact ────────────────────────────────────────────

export function ContactTasks({ contactId, onChanged }: { contactId: string; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState('normal');
  const [notice, setNotice] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: ['crm-tasks', contactId],
    queryFn: () => api.crm.tasks.list({ status: 'open', contactId }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['crm-tasks'] });
    queryClient.invalidateQueries({ queryKey: ['crm-tasks-due'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contact'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contacts'] });
    onChanged?.();
  };
  const create = useMutation({
    mutationFn: () => api.crm.tasks.create({ title: title.trim(), contactId, dueAt: toIso(due), priority }),
    onSuccess: () => { setNotice('Follow-up added.'); setTitle(''); setDue(''); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not add the follow-up.'),
  });
  const complete = useMutation({
    mutationFn: (id: string) => api.crm.tasks.complete(id),
    onSuccess: () => { setNotice('Follow-up done.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not complete the follow-up.'),
  });

  const open = tasks.data?.tasks ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>Follow-ups</div>
      {open.length === 0 && <div style={label}>No open follow-up.</div>}
      {open.map((task) => (
        <div key={task.id} style={{ ...row, justifyContent: 'space-between' }}>
          <span style={wrap}>
            {task.title}
            {task.dueAt ? ` · due ${new Date(task.dueAt).toLocaleDateString()}` : ''}
            {task.overdue ? ' · overdue' : ''}
          </span>
          <button type="button" style={buttonStyle} onClick={() => complete.mutate(task.id)}>Done</button>
        </div>
      ))}
      <div style={row}>
        <input aria-label="Follow-up title" placeholder="Follow up about…" value={title} onChange={(event) => setTitle(event.target.value)} style={inputStyle} />
        <input aria-label="Follow-up due" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} style={inputStyle} />
        <select aria-label="Follow-up priority" value={priority} onChange={(event) => setPriority(event.target.value)} style={inputStyle}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <button type="button" style={buttonStyle} disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>Add follow-up</button>
      </div>
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Opt-outs you can lift ───────────────────────────────────────────────────

/**
 * Recorded opt-outs for this contact. Lifting one channel is the default and
 * keeps the row as history; clearing the contact-level do-not-contact flag is a
 * separate, explicit decision and is refused while another record still blocks
 * the same person on that channel.
 */
export function ContactOptOuts({ contactId, onChanged }: { contactId: string; onChanged?: () => void }) {
  const [liftId, setLiftId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [alsoClear, setAlsoClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['crm-suppressions', contactId],
    queryFn: () => api.crm.suppressions.forContact(contactId),
  });

  const lift = useMutation({
    mutationFn: (id: string) => api.crm.suppressions.lift(id, { reason: reason || undefined, alsoClearDoNotContact: alsoClear }),
    onSuccess: (result) => {
      setNotice(`Lifted the ${result.channel} opt-out${result.clearedDoNotContact ? ' and cleared do-not-contact.' : '.'}`);
      setLiftId(null);
      setReason('');
      setAlsoClear(false);
      list.refetch();
      onChanged?.();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not lift the opt-out.'),
  });

  const rows = list.data?.suppressions ?? [];
  const active = rows.filter((item) => !item.liftedAt);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Opt-outs</div>
        <span style={label}>{active.length} blocking · {rows.length - active.length} lifted</span>
      </div>
      {rows.length === 0 && <div style={label}>Nothing recorded.</div>}
      {rows.map((item) => (
        <div key={item.id} style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
          <div style={{ ...wrap, flex: '1 1 240px' }}>
            <div style={{ fontWeight: 650 }}>
              {item.channel} · {item.reason}
              {item.liftedAt ? ' · lifted' : ''}
            </div>
            <div style={label}>
              {[item.phoneE164 ?? item.email, new Date(item.createdAt).toLocaleDateString(), item.liftedBy ? `lifted by ${item.liftedBy}` : null]
                .filter(Boolean).join(' · ')}
            </div>
          </div>
          {!item.liftedAt && (
            <button type="button" style={buttonStyle} onClick={() => setLiftId(liftId === item.id ? null : item.id)}>
              {liftId === item.id ? 'Cancel' : 'Lift opt-out'}
            </button>
          )}
        </div>
      ))}
      {liftId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={row}>
            <input aria-label="Why you are lifting this" placeholder="Why (recorded)" value={reason} onChange={(event) => setReason(event.target.value)} style={inputStyle} />
            <label style={{ ...row, fontSize: 13, gap: 6 }}>
              <input type="checkbox" checked={alsoClear} onChange={(event) => setAlsoClear(event.target.checked)} />
              Also clear do-not-contact
            </label>
            <button type="button" style={buttonStyle} disabled={lift.isPending} onClick={() => lift.mutate(liftId)}>Lift</button>
          </div>
          <div style={label}>
            Lifting keeps the record and unblocks that channel. Clearing do-not-contact unblocks every channel and is refused while another record still blocks this person.
          </div>
        </div>
      )}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── A new contact by hand ───────────────────────────────────────────────────

export function NewContactForm({ onCreated }: { onCreated?: (contactId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({ tags: '' });
  const [notice, setNotice] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.crm.createContact({
      firstName: draft.firstName,
      lastName: draft.lastName,
      organizationName: draft.organizationName,
      title: draft.title,
      email: draft.email,
      phone: draft.phone,
      city: draft.city,
      state: draft.state,
      website: draft.website,
      notes: draft.notes,
      ownerBot: draft.ownerBot,
      tags: (draft.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
    }),
    onSuccess: (result) => { setNotice('Contact created.'); setDraft({ tags: '' }); onCreated?.(result.contactId); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not create the contact.'),
  });

  const fields: Array<[string, string]> = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['organizationName', 'Organization'],
    ['title', 'Title'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['city', 'City'],
    ['state', 'State'],
    ['website', 'Website'],
    ['ownerBot', 'Owner bot'],
    ['tags', 'Tags (comma separated)'],
  ];

  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Add a contact</div>
        <button type="button" style={buttonStyle} onClick={() => setOpen((value) => !value)}>{open ? 'Close' : 'Open'}</button>
      </div>
      {open && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {fields.map(([key, placeholder]) => (
              <input
                key={key}
                aria-label={placeholder}
                placeholder={placeholder}
                value={draft[key] ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                style={inputStyle}
              />
            ))}
          </div>
          <textarea
            aria-label="Notes"
            placeholder="Notes"
            value={draft.notes ?? ''}
            onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
            rows={2}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
          <div style={row}>
            <button type="button" className="btn-primary" style={buttonStyle} disabled={create.isPending} onClick={() => create.mutate()}>
              Create contact
            </button>
            <span style={label}>A contact needs a name, an organization, an email, a phone, or a website.</span>
          </div>
        </>
      )}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

// ─── Researched leads → the contact book ─────────────────────────────────────

/**
 * The reviewed copy. Preview first, always: the button that writes says how many
 * contacts it is about to add. The copy is undoable, and the undo keeps any
 * contact that has since been called, emailed, enrolled or opted out.
 */
export function LeadImportPanel({ onOpenContact }: { onOpenContact?: (contactId: string) => void }) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<CrmLeadImportFilters>({ limit: 100, reachableOnly: true });
  const [preview, setPreview] = useState<CrmLeadImportPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const history = useQuery({ queryKey: ['crm-lead-imports'], queryFn: () => api.crm.leadImport.list() });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['crm-lead-imports'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contacts'] });
    queryClient.invalidateQueries({ queryKey: ['crm-leads'] });
  };
  const runPreview = useMutation({
    mutationFn: () => api.crm.leadImport.preview(filters),
    onSuccess: (result) => { setPreview(result); setNotice(null); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not build the preview.'),
  });
  const apply = useMutation({
    mutationFn: () => api.crm.leadImport.apply(filters),
    onSuccess: (result) => {
      setNotice(`Copied ${result.created} lead${result.created === 1 ? '' : 's'} into the contact book (${result.matched} already there, ${result.skipped} skipped).`);
      setPreview(null);
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not copy the leads.'),
  });
  const undo = useMutation({
    mutationFn: (batchId: string) => api.crm.leadImport.undo(batchId),
    onSuccess: (result) => {
      setNotice(`Undo removed ${result.removed} contact${result.removed === 1 ? '' : 's'} and kept ${result.kept} that had activity since.`);
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not undo the copy.'),
  });

  const batches = history.data?.imports ?? [];
  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Contact book</div>
        <span style={label}>Researched leads live in their own table until you copy them across. Nothing is copied until you say so.</span>
      </div>
      <div style={row}>
        <input
          aria-label="How many leads"
          placeholder="How many"
          value={String(filters.limit ?? '')}
          onChange={(event) => setFilters((current) => ({ ...current, limit: Number(event.target.value) || undefined }))}
          style={inputStyle}
        />
        <input aria-label="Industry" placeholder="Industry" value={filters.industry ?? ''} onChange={(event) => setFilters((current) => ({ ...current, industry: event.target.value || undefined }))} style={inputStyle} />
        <input aria-label="City" placeholder="City" value={filters.city ?? ''} onChange={(event) => setFilters((current) => ({ ...current, city: event.target.value || undefined }))} style={inputStyle} />
        <select aria-label="Lead status" value={filters.status ?? ''} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value || undefined }))} style={inputStyle}>
          <option value="">Any lead status</option>
          <option value="new">new</option>
          <option value="contacted">contacted</option>
          <option value="qualified">qualified</option>
        </select>
        <label style={{ ...row, fontSize: 13, gap: 6 }}>
          <input
            type="checkbox"
            checked={filters.reachableOnly !== false}
            onChange={(event) => setFilters((current) => ({ ...current, reachableOnly: event.target.checked }))}
          />
          Only leads with an email or phone
        </label>
        <button type="button" style={buttonStyle} disabled={runPreview.isPending} onClick={() => runPreview.mutate()}>Preview</button>
      </div>

      {preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>
            {preview.considered} leads considered · {preview.wouldCreate} would become contacts · {preview.alreadyInBook} already in the book · {preview.skipped} skipped
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {preview.rows.map((item) => (
              <div key={item.leadId} style={{ ...row, justifyContent: 'space-between', fontSize: 12 }}>
                <span style={wrap}>{[item.companyName, item.contactName, item.city].filter(Boolean).join(' · ')}</span>
                <span style={{ color: item.action === 'create' ? '#5fae7f' : 'var(--color-apex-muted)' }}>
                  {item.action === 'create' ? 'new contact' : item.action === 'matched' ? 'already in the book' : item.reason ?? 'skipped'}
                </span>
              </div>
            ))}
            {preview.truncated && <div style={label}>Preview capped at 100 rows.</div>}
          </div>
          <div style={row}>
            <button
              type="button"
              className="btn-primary"
              style={buttonStyle}
              disabled={preview.wouldCreate === 0 || apply.isPending}
              onClick={() => apply.mutate()}
            >
              Copy {preview.wouldCreate} into the contact book
            </button>
            <span style={label}>Needs your dashboard sign-in. The copy is undoable.</span>
          </div>
        </div>
      )}

      {batches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Copies</div>
          {batches.map((batch) => (
            <div key={batch.id} style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
              <span style={wrap}>
                {new Date(batch.appliedAt).toLocaleString()} · created {batch.createdCount} · kept {batch.matched} · status {batch.status}
              </span>
              {batch.status === 'applied' && (
                <button type="button" style={buttonStyle} disabled={undo.isPending} onClick={() => undo.mutate(batch.id)}>Undo</button>
              )}
            </div>
          ))}
        </div>
      )}

      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
      {onOpenContact && <div style={label}>Open a contact from the Contacts view.</div>}
    </div>
  );
}