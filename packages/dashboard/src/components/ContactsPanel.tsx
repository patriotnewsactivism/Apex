import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, CRM_LIFECYCLE_STAGES, type CrmContactFilters } from '../lib/api.js';
import { COPILOT_PANEL_EVENT, type CopilotPanelEventDetail } from '../copilot/actions.js';
import {
  ContactEditForm,
  ContactOptOuts,
  ContactStatusControl,
  ContactTasks,
  DueTodayPanel,
  LeadImportPanel,
  LifecycleBadge,
  LogCallForm,
  NewContactForm,
  TagEditor,
} from './CrmOperatorPanels.js';

const wrap: CSSProperties = {
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  minWidth: 0,
  maxWidth: '100%',
};

function contactName(row: { firstName: string | null; lastName: string | null; organizationName: string | null; email: string | null }): string {
  const person = [row.firstName, row.lastName].filter(Boolean).join(' ');
  return person || row.organizationName || row.email || 'Unnamed contact';
}

export function ContactsPanel() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<CrmContactFilters>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openTimeline, setOpenTimeline] = useState<string | null>(null);
  const [dncReason, setDncReason] = useState('');
  const [attachTo, setAttachTo] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['crm-contacts', filters],
    queryFn: () => api.crm.list(filters),
  });
  const detail = useQuery({
    queryKey: ['crm-contact', selectedId],
    queryFn: () => api.crm.get(selectedId!),
    enabled: Boolean(selectedId),
  });
  const unmatched = useQuery({
    queryKey: ['crm-unmatched'],
    queryFn: () => api.crm.unmatched(),
  });
  const duplicates = useQuery({
    queryKey: ['crm-duplicates'],
    queryFn: () => api.crm.duplicates(),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['crm-contacts'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contact'] });
    queryClient.invalidateQueries({ queryKey: ['crm-unmatched'] });
    queryClient.invalidateQueries({ queryKey: ['crm-duplicates'] });
  };

  const setDnc = useMutation({
    mutationFn: (value: boolean) => api.crm.setDoNotContact(selectedId!, value, dncReason || undefined),
    onSuccess: () => { setNotice('Do-not-contact updated by Matthew.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Do-not-contact update failed'),
  });
  const attach = useMutation({
    mutationFn: ({ id, contactId }: { id: string; contactId: string }) => api.crm.attachUnmatched(id, contactId),
    onSuccess: () => { setNotice('Unmatched message attached.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Attach failed'),
  });
  const merge = useMutation({
    mutationFn: ({ winnerId, loserId }: { winnerId: string; loserId: string }) => api.crm.merge(winnerId, loserId),
    onSuccess: () => { setNotice('Contacts merged. Both timelines are kept.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Merge failed'),
  });

  const contacts = list.data?.contacts ?? [];
  const field = (key: keyof CrmContactFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
  };

  useEffect(() => {
    const handleCopilotAction = (event: Event) => {
      const detail = (event as CustomEvent<CopilotPanelEventDetail>).detail;
      const action = detail?.action;
      if (!action) return;
      if (action.type === 'search' && action.page === 'contacts') {
        setFilters((current) => ({ ...current, q: action.query }));
        detail.acknowledge({ ok: true });
        return;
      }
      if (action.type === 'openRecord' && action.recordType === 'contact') {
        setSelectedId(action.id);
        detail.acknowledge({ ok: true });
        return;
      }
      if (action.type !== 'setFilter' || action.page !== 'contacts') return;
      switch (action.field) {
        case 'q':
        case 'tag':
        case 'city':
        case 'state':
        case 'ownerBot':
        case 'campaignId':
        case 'industry':
        case 'lifecycleStage':
          if (typeof action.value === 'string') {
            setFilters((current) => ({ ...current, [action.field]: action.value || undefined }));
            detail.acknowledge({ ok: true });
          } else {
            detail.acknowledge({ ok: false, reason: `Filter ${action.field} requires text.` });
          }
          break;
        case 'verifiedOnly':
        case 'replied':
        case 'called':
        case 'emailed':
        case 'doNotContact':
        case 'followUpDueToday':
          if (typeof action.value === 'boolean' || action.value === null) {
            setFilters((current) => ({ ...current, [action.field]: action.value }));
            detail.acknowledge({ ok: true });
          } else {
            detail.acknowledge({ ok: false, reason: `Filter ${action.field} requires true, false, or null.` });
          }
          break;
        default:
          detail.acknowledge({ ok: false, reason: `Filter ${action.field} is not registered.` });
      }
    };
    window.addEventListener(COPILOT_PANEL_EVENT, handleCopilotAction);
    return () => window.removeEventListener(COPILOT_PANEL_EVENT, handleCopilotAction);
  }, []);

  const exportCsv = async () => {
    const blob = await api.crm.exportCsv(filters);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `apex-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <DueTodayPanel onOpenContact={(contactId) => setSelectedId(contactId)} />
      <NewContactForm onCreated={(contactId) => { setSelectedId(contactId); refresh(); }} />
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={wrap}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Contacts</div>
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
              {contacts.length} in this view · times shown in America/Chicago
            </div>
          </div>
          <button type="button" onClick={exportCsv} style={{ padding: '8px 12px' }}>Export CSV</button>
        </div>
        <input
          data-copilot-target="contacts-search"
          aria-label="Search contacts"
          placeholder="Search name, organization, email, phone, tags, notes, or message text"
          value={filters.q ?? ''}
          onChange={(event) => field('q', event.target.value)}
          style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input data-copilot-target="contacts-filter-tag" aria-label="Tag" placeholder="Tag" value={filters.tag ?? ''} onChange={(e) => field('tag', e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
          <input data-copilot-target="contacts-filter-city" aria-label="City" placeholder="City" value={filters.city ?? ''} onChange={(e) => field('city', e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
          <input data-copilot-target="contacts-filter-state" aria-label="State" placeholder="State" value={filters.state ?? ''} onChange={(e) => field('state', e.target.value)} style={{ flex: '1 1 80px', minWidth: 0 }} />
          <input data-copilot-target="contacts-filter-ownerBot" aria-label="Owner bot" placeholder="Owner bot" value={filters.ownerBot ?? ''} onChange={(e) => field('ownerBot', e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
          <input data-copilot-target="contacts-filter-campaignId" aria-label="Campaign" placeholder="Campaign id" value={filters.campaignId ?? ''} onChange={(e) => field('campaignId', e.target.value)} style={{ flex: '1 1 140px', minWidth: 0 }} />
          <input aria-label="Last contacted from" type="date" value={filters.lastContactedFrom?.slice(0, 10) ?? ''} onChange={(e) => field('lastContactedFrom', e.target.value)} style={{ flex: '1 1 140px', minWidth: 0 }} />
          <input aria-label="Last contacted to" type="date" value={filters.lastContactedTo?.slice(0, 10) ?? ''} onChange={(e) => field('lastContactedTo', e.target.value)} style={{ flex: '1 1 140px', minWidth: 0 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input data-copilot-target="contacts-filter-verifiedOnly" type="checkbox" checked={filters.verifiedOnly === true} onChange={(e) => setFilters((c) => ({ ...c, verifiedOnly: e.target.checked }))} />
            Verified only
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={filters.doNotContact === true} onChange={(e) => setFilters((c) => ({ ...c, doNotContact: e.target.checked ? true : null }))} />
            Do not contact
          </label>
          <select
            data-copilot-target="contacts-filter-replied"
            aria-label="Reply filter"
            value={filters.replied === true ? 'yes' : filters.replied === false ? 'no' : ''}
            onChange={(e) => setFilters((c) => ({ ...c, replied: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null }))}
          >
            <option value="">Replied or not</option>
            <option value="yes">Replied</option>
            <option value="no">Not replied</option>
          </select>
          <input data-copilot-target="contacts-filter-industry" aria-label="Industry" placeholder="Industry" value={filters.industry ?? ''} onChange={(e) => field('industry', e.target.value)} style={{ flex: '1 1 120px', minWidth: 0 }} />
          <select
            data-copilot-target="contacts-filter-called"
            aria-label="Called filter"
            value={filters.called === true ? 'yes' : filters.called === false ? 'no' : ''}
            onChange={(e) => setFilters((c) => ({ ...c, called: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null }))}
          >
            <option value="">Called or not</option>
            <option value="yes">Called</option>
            <option value="no">Not called</option>
          </select>
          <select
            data-copilot-target="contacts-filter-emailed"
            aria-label="Emailed filter"
            value={filters.emailed === true ? 'yes' : filters.emailed === false ? 'no' : ''}
            onChange={(e) => setFilters((c) => ({ ...c, emailed: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null }))}
          >
            <option value="">Emailed or not</option>
            <option value="yes">Emailed</option>
            <option value="no">Not emailed</option>
          </select>
          <select
            data-copilot-target="contacts-filter-lifecycle"
            aria-label="Client status"
            value={filters.lifecycleStage ?? ''}
            onChange={(e) => setFilters((c) => ({ ...c, lifecycleStage: (e.target.value || null) as CrmContactFilters['lifecycleStage'] }))}
          >
            <option value="">Any client status</option>
            {CRM_LIFECYCLE_STAGES.map((stage) => (
              <option key={stage} value={stage}>{stage}</option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              data-copilot-target="contacts-filter-followUpDueToday"
              type="checkbox"
              checked={filters.followUpDueToday === true}
              onChange={(e) => setFilters((c) => ({ ...c, followUpDueToday: e.target.checked ? true : null }))}
            />
            Follow-up due
          </label>
        </div>
        {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
        {list.isError && <div style={wrap}>Could not load contacts.</div>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start', minWidth: 0 }}>
        <div className="glass-card" style={{ flex: '1 1 280px', minWidth: 0, padding: 8 }}>
          {contacts.length === 0 && <div style={{ padding: 12, ...wrap }}>No contacts match this view.</div>}
          {contacts.map((row) => (
            <button
              key={row.id}
              data-copilot-record={row.id}
              type="button"
              onClick={() => setSelectedId(row.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: 12,
                border: 'none',
                background: selectedId === row.id ? 'rgba(201,168,74,0.12)' : 'transparent',
                color: 'inherit',
                ...wrap,
              }}
            >
              <div style={{ fontWeight: 650 }}>{contactName(row)}</div>
              <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', ...wrap }}>
                {[row.organizationName, row.email, row.phoneE164, row.city, row.state].filter(Boolean).join(' · ')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <LifecycleBadge stage={row.lifecycleStage} />
                {row.nextFollowUpChicago && (
                  <span style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>follow up {row.nextFollowUpChicago}</span>
                )}
              </div>
              {row.doNotContact && <div style={{ fontSize: 12, color: '#c45c66' }}>Do not contact</div>}
            </button>
          ))}
        </div>

        <div className="glass-card" style={{ flex: '2 1 320px', minWidth: 0, padding: 16 }}>
          {!selectedId && <div style={wrap}>Select a contact to see the profile, timeline, and meetings.</div>}
          {detail.data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <div style={wrap}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{contactName(detail.data.contact)}</div>
                <div>{detail.data.contact.title}</div>
                <div>{detail.data.contact.organizationName}</div>
                <div>{detail.data.contact.email} {detail.data.contact.phoneE164}</div>
                <div>{[detail.data.contact.city, detail.data.contact.state].filter(Boolean).join(', ')}</div>
                <div>{detail.data.contact.website}</div>
                <div>Tags: {(detail.data.contact.tags ?? []).join(', ') || 'none'}</div>
                <div>Owner: {detail.data.contact.ownerBot || 'unassigned'}</div>
                <div style={wrap}>{detail.data.contact.notes}</div>
              </div>
              <ContactStatusControl contact={detail.data.contact} onChanged={refresh} />
              <ContactEditForm contact={detail.data.contact} onSaved={refresh} />
              <TagEditor contact={detail.data.contact} onChanged={refresh} />
              <ContactTasks contactId={detail.data.contact.id} onChanged={refresh} />
              <LogCallForm contactId={detail.data.contact.id} onLogged={refresh} />
              <ContactOptOuts contactId={detail.data.contact.id} onChanged={refresh} />
              <div>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Identifiers</div>
                {detail.data.identifiers.map((item) => (
                  <div key={item.id} style={{ fontSize: 13, ...wrap }}>
                    {item.kind}: {item.value} · {item.verified ? 'verified' : 'unverified'}
                    {item.sourceUrl ? ` · ${item.sourceUrl}` : ''}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Do not contact</div>
                <div style={{ fontSize: 13, ...wrap }}>
                  {detail.data.contact.doNotContact
                    ? `Set by ${detail.data.contact.doNotContactSetBy ?? 'unknown'}: ${detail.data.contact.doNotContactReason ?? ''}`
                    : 'Contact is allowed.'}
                </div>
                <input
                  aria-label="Do not contact reason"
                  placeholder="Reason"
                  value={dncReason}
                  onChange={(e) => setDncReason(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', margin: '8px 0' }}
                />
                <button type="button" onClick={() => setDnc.mutate(!detail.data.contact.doNotContact)}>
                  {detail.data.contact.doNotContact ? 'Clear do-not-contact (Matthew)' : 'Set do-not-contact'}
                </button>
              </div>
              <div>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Meetings</div>
                {detail.data.meetings.length === 0 && <div style={{ fontSize: 13 }}>No meetings.</div>}
                {detail.data.meetings.map((meeting) => (
                  <div key={meeting.id} style={{ fontSize: 13, ...wrap }}>
                    {meeting.title || 'Meeting'} · {meeting.startsAt ? new Date(meeting.startsAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : 'unscheduled'} · {meeting.status}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Activity — every channel</div>
                {(detail.data.activity ?? []).length === 0 && (
                  <div style={{ fontSize: 13 }}>No logged activity yet.</div>
                )}
                {(detail.data.activity ?? []).map((row) => (
                  <div key={row.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '6px 0', ...wrap }}>
                    <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
                      {row.occurredChicago} · {row.kind}
                      {row.direction ? ` · ${row.direction}` : ''}
                      {row.actor ? ` · ${row.actor}` : ''}
                    </div>
                    <div style={{ fontSize: 13 }}>{row.summary}</div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 650, marginBottom: 6 }}>Timeline</div>
                {detail.data.timeline.map((row) => {
                  const open = openTimeline === row.id;
                  return (
                    <div key={row.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px 0', ...wrap }}>
                      <button type="button" onClick={() => setOpenTimeline(open ? null : row.id)} style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, textAlign: 'left', ...wrap }}>
                        <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
                          {row.occurredChicago} · {row.channel} · {row.direction} · {row.actorName}
                        </div>
                        <div>{row.subject || row.eventKind}</div>
                      </button>
                      {open && (
                        <div style={{ marginTop: 6, fontSize: 13, ...wrap }}>
                          <div>{row.bodyText}</div>
                          {row.providerMessageId && <div>Provider id: {row.providerMessageId}</div>}
                          {(row.attachments ?? []).map((file) => (
                            <div key={file.storageKey ?? file.filename}>{file.filename} · {file.contentType} · {file.sizeBytes ?? 0} bytes</div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Unmatched inbound</div>
        {(unmatched.data ?? []).length === 0 && <div style={wrap}>The unmatched queue is empty.</div>}
        {(unmatched.data ?? []).map((row) => (
          <div key={row.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.08)', ...wrap }}>
            <div>{row.fromAddress} · {row.subject}</div>
            <div style={{ fontSize: 13 }}>{row.bodyText}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              <input
                aria-label={`Attach ${row.id}`}
                placeholder="Contact id"
                value={attachTo[row.id] ?? ''}
                onChange={(e) => setAttachTo((current) => ({ ...current, [row.id]: e.target.value }))}
                style={{ flex: '1 1 180px', minWidth: 0 }}
              />
              <button type="button" onClick={() => attach.mutate({ id: row.id, contactId: attachTo[row.id] ?? '' })}>Attach</button>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card" style={{ padding: 16, minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Possible duplicates</div>
        <div style={{ fontSize: 13, marginBottom: 8, ...wrap }}>Suggestions stay suggestions until Matthew merges them.</div>
        {(duplicates.data ?? []).length === 0 && <div>No duplicate suggestions.</div>}
        {(duplicates.data ?? []).map((row) => (
          <div key={`${row.kind}:${row.value}`} style={{ padding: '8px 0', ...wrap }}>
            <div>{row.kind}: {row.value}</div>
            <div style={{ fontSize: 12 }}>{row.contactIds.join(', ')}</div>
            {row.contactIds[0] && row.contactIds[1] && (
              <button type="button" onClick={() => merge.mutate({ winnerId: row.contactIds[0] ?? '', loserId: row.contactIds[1] ?? '' })}>
                Merge into first contact
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
