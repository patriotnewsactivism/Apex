/**
 * CRM phase 2: the pipeline board, and the company page.
 *
 * The board is the existing pipeline_stages + sales_opportunities pair, which
 * had no screen until now. Each column is a stage; a deal carries its value, its
 * expected close date and the next step. Closing a deal as won needs the
 * operator dashboard session, because a win is what turns a contact into a
 * client — the panel says so rather than pretending the click landed.
 */
import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CrmDeal, type CrmCompanyRow } from '../lib/api.js';
import { LifecycleBadge } from './CrmOperatorPanels.js';

const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const label: CSSProperties = { fontSize: 12, color: 'var(--color-apex-muted)' };
const input: CSSProperties = { flex: '1 1 140px', minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)' };
const button: CSSProperties = { padding: '6px 10px' };
const card: CSSProperties = { minWidth: 0, padding: 12, borderRadius: 10, background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)' };

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function dealLine(deal: CrmDeal): string {
  return [
    usd(deal.amountUsd),
    deal.expectedCloseChicago ? `closes ${deal.expectedCloseChicago}` : 'no close date',
    deal.probability !== null ? `${Math.round(deal.probability * 100)}%` : null,
    deal.contactName,
  ].filter(Boolean).join(' · ');
}

export function DealsPipelinePanel({ onOpenCompany }: { onOpenCompany?: (companyId: string) => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [closeFor, setCloseFor] = useState<{ id: string; outcome: 'won' | 'lost' } | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [closeAmount, setCloseAmount] = useState('');

  const board = useQuery({ queryKey: ['crm-pipeline'], queryFn: () => api.crm.pipeline() });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['crm-pipeline'] });
    queryClient.invalidateQueries({ queryKey: ['crm-deals'] });
    queryClient.invalidateQueries({ queryKey: ['crm-contact'] });
    queryClient.invalidateQueries({ queryKey: ['crm-companies'] });
  };
  const move = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => api.crm.deals.move(id, stageId),
    onSuccess: () => { setNotice('Deal moved.'); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not move the deal.'),
  });
  const close = useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: 'won' | 'lost' }) =>
      api.crm.deals.close(id, { outcome, reason: closeReason || undefined, amount: closeAmount || undefined }),
    onSuccess: (result) => {
      setNotice(
        result.status === 'won'
          ? `Deal marked won${result.clientStatusChanged ? '; the contact is now a client.' : '.'}`
          : 'Deal marked lost.',
      );
      setCloseFor(null);
      setCloseReason('');
      setCloseAmount('');
      refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not close the deal.'),
  });
  const create = useMutation({
    mutationFn: () => api.crm.deals.create({
      name: draft.name ?? '',
      contactId: draft.contactId || undefined,
      amount: draft.amount || undefined,
      expectedCloseAt: toIso(draft.expectedCloseAt ?? ''),
      nextStep: draft.nextStep || undefined,
      stageId: draft.stageId || undefined,
      probability: draft.probability ? Number(draft.probability) : null,
    }),
    onSuccess: () => { setNotice('Deal opened.'); setDraft({}); setNewOpen(false); refresh(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not open the deal.'),
  });

  const data = board.data;
  const stages = data?.stages ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={row}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Pipeline</div>
          {data && (
            <span style={label}>
              {data.open.count} open · {usd(data.open.totalUsd)} open · {usd(data.open.weightedUsd)} weighted ·{' '}
              {usd(data.open.closingThisMonthUsd)} closing this month
            </span>
          )}
        </div>
        {data && (
          <div style={{ ...label }}>
            Won {data.closed.won} ({usd(data.closed.wonUsd)}) · lost {data.closed.lost} ({usd(data.closed.lostUsd)})
          </div>
        )}
        <div style={row}>
          <button type="button" style={button} onClick={() => setNewOpen((value) => !value)}>
            {newOpen ? 'Close' : 'Open a deal'}
          </button>
          <span style={label}>A deal carries a value, a close date and the next step.</span>
        </div>
        {newOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div style={row}>
              {([['name', 'Deal name'], ['contactId', 'Contact id'], ['amount', 'Value in dollars'], ['nextStep', 'Next step'], ['probability', 'Probability 0-1']] as Array<[string, string]>).map(([key, placeholder]) => (
                <input
                  key={key}
                  aria-label={placeholder}
                  placeholder={placeholder}
                  value={draft[key] ?? ''}
                  onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
                  style={input}
                />
              ))}
              <input
                aria-label="Expected close"
                type="datetime-local"
                value={draft.expectedCloseAt ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, expectedCloseAt: event.target.value }))}
                style={input}
              />
              <select
                aria-label="Stage"
                value={draft.stageId ?? ''}
                onChange={(event) => setDraft((current) => ({ ...current, stageId: event.target.value }))}
                style={input}
              >
                <option value="">First stage</option>
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.name}</option>
                ))}
              </select>
            </div>
            <div style={row}>
              <button
                type="button"
                className="btn-primary"
                style={button}
                disabled={!draft.name?.trim() || create.isPending}
                onClick={() => create.mutate()}
              >
                Open deal
              </button>
            </div>
          </div>
        )}
        {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
      </div>

      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6, minWidth: 0 }}>
        {stages.map((stage) => (
          <div key={stage.id} style={{ ...card, flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={row}>
              <div style={{ fontWeight: 700 }}>{stage.name}</div>
              <span style={label}>{stage.deals.length} · {usd(stage.totalUsd)}</span>
            </div>
            {stage.deals.length === 0 && <span style={label}>Empty.</span>}
            {stage.deals.map((deal) => (
              <div key={deal.id} style={{ ...card, background: 'rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ ...wrap, fontWeight: 650 }}>{deal.name}</div>
                <div style={{ ...label, ...wrap }}>{dealLine(deal)}</div>
                {deal.nextStep && <div style={{ ...label, ...wrap }}>Next: {deal.nextStep}</div>}
                <select
                  aria-label={`Move ${deal.name}`}
                  value={deal.stageId ?? ''}
                  onChange={(event) => move.mutate({ id: deal.id, stageId: event.target.value })}
                  style={{ ...input, flex: '1 1 100%' }}
                >
                  {stages.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
                <div style={row}>
                  <button type="button" style={button} onClick={() => { setCloseFor({ id: deal.id, outcome: 'won' }); setCloseAmount(deal.amountUsd ? String(deal.amountUsd) : ''); }}>Won</button>
                  <button type="button" style={button} onClick={() => { setCloseFor({ id: deal.id, outcome: 'lost' }); setCloseAmount(''); }}>Lost</button>
                  {deal.companyId && onOpenCompany && (
                    <button type="button" style={button} onClick={() => onOpenCompany(deal.companyId!)}>Company</button>
                  )}
                </div>
                {closeFor?.id === deal.id && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <input
                      aria-label="Closed value"
                      placeholder="Closed value in dollars"
                      value={closeAmount}
                      onChange={(event) => setCloseAmount(event.target.value)}
                      style={{ ...input, flex: '1 1 100%' }}
                    />
                    <input
                      aria-label="Why"
                      placeholder={closeFor.outcome === 'won' ? 'Why they signed' : 'Why it was lost'}
                      value={closeReason}
                      onChange={(event) => setCloseReason(event.target.value)}
                      style={{ ...input, flex: '1 1 100%' }}
                    />
                    <div style={row}>
                      <button
                        type="button"
                        className={closeFor.outcome === 'won' ? 'btn-primary' : 'btn-secondary'}
                        style={button}
                        disabled={close.isPending}
                        onClick={() => close.mutate({ id: deal.id, outcome: closeFor.outcome })}
                      >
                        Mark {closeFor.outcome} (Matthew)
                      </button>
                      <button type="button" style={button} onClick={() => setCloseFor(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {(data?.unassigned.deals.length ?? 0) > 0 && (
          <div style={{ ...card, flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={row}>
              <div style={{ fontWeight: 700 }}>No stage</div>
              <span style={label}>{data?.unassigned.deals.length} · {usd(data?.unassigned.totalUsd ?? 0)}</span>
            </div>
            {data?.unassigned.deals.map((deal) => (
              <div key={deal.id} style={{ ...card, background: 'rgba(255,255,255,0.04)' }}>
                <div style={{ ...wrap, fontWeight: 650 }}>{deal.name}</div>
                <div style={{ ...label, ...wrap }}>{dealLine(deal)}</div>
                <select
                  aria-label={`Move ${deal.name}`}
                  value=""
                  onChange={(event) => move.mutate({ id: deal.id, stageId: event.target.value })}
                  style={{ ...input, flex: '1 1 100%' }}
                >
                  <option value="">Move to…</option>
                  {stages.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CompaniesPanel() {
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['crm-companies', query, industry],
    queryFn: () => api.crm.companies.list({ q: query || undefined, industry: industry || undefined }),
  });
  const detail = useQuery({
    queryKey: ['crm-company', selectedId],
    queryFn: () => api.crm.companies.get(selectedId!),
    enabled: Boolean(selectedId),
  });

  const companies: CrmCompanyRow[] = list.data?.companies ?? [];
  const page = detail.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={row}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Companies</div>
          <span style={label}>{companies.length} shown</span>
        </div>
        <div style={row}>
          <input aria-label="Search companies" placeholder="Name, domain or industry" value={query} onChange={(event) => setQuery(event.target.value)} style={input} />
          <input aria-label="Industry filter" placeholder="Industry" value={industry} onChange={(event) => setIndustry(event.target.value)} style={input} />
        </div>
        {list.isError && <div style={wrap}>Could not load companies.</div>}
        {companies.length === 0 && !list.isLoading && <div style={label}>No companies yet. They appear as contacts and deals are linked to one.</div>}
        {companies.map((company) => (
          <button
            key={company.id}
            type="button"
            onClick={() => setSelectedId(company.id)}
            style={{ textAlign: 'left', background: 'none', border: 'none', color: 'inherit', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', ...wrap }}
          >
            <div style={{ fontWeight: 650 }}>{company.name}</div>
            <div style={label}>
              {[company.industry, company.domain, `${company.contactCount} contact${company.contactCount === 1 ? '' : 's'}`,
                `${company.openDeals} open`, usd(company.openValueUsd) + ' open', company.wonValueUsd > 0 ? `${usd(company.wonValueUsd)} won` : null]
                .filter(Boolean).join(' · ')}
            </div>
          </button>
        ))}
      </div>

      {page && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={row}>
            <div style={{ fontSize: 18, fontWeight: 700, ...wrap }}>{page.company.name}</div>
            <button type="button" style={button} onClick={() => setSelectedId(null)}>Close</button>
          </div>
          <div style={{ ...label, ...wrap }}>
            {[page.company.industry, page.company.domain, page.company.website, page.company.employeeCount ? `${page.company.employeeCount} employees` : null]
              .filter(Boolean).join(' · ') || 'No company detail recorded yet.'}
          </div>
          <div style={{ ...label }}>
            {page.totals.openCount} open ({usd(page.totals.openValueUsd)}) · {page.totals.wonCount} won ({usd(page.totals.wonValueUsd)}) ·{' '}
            {page.totals.lostCount} lost · {page.openTasks} open follow-up{page.openTasks === 1 ? '' : 's'}
            {page.lastActivityChicago ? ` · last activity ${page.lastActivityChicago}` : ''}
          </div>

          <div>
            <div style={{ fontWeight: 650, marginBottom: 6 }}>Contacts</div>
            {page.contacts.length === 0 && <div style={label}>No contacts linked to this company yet.</div>}
            {page.contacts.map((contact) => (
              <div key={contact.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.08)', ...wrap }}>
                <div style={{ fontWeight: 600 }}>{contact.name}</div>
                <div style={{ ...row, gap: 6, marginTop: 4 }}>
                  <LifecycleBadge stage={contact.lifecycleStage} />
                  <span style={label}>
                    {[contact.title, contact.email, contact.phoneE164, [contact.city, contact.state].filter(Boolean).join(', ')]
                      .filter(Boolean).join(' · ')}
                  </span>
                  {contact.doNotContact && <span style={{ fontSize: 12, color: '#c45c66' }}>do not contact</span>}
                </div>
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontWeight: 650, marginBottom: 6 }}>Deals</div>
            {page.deals.length === 0 && <div style={label}>No deals on this account yet.</div>}
            {page.deals.map((deal) => (
              <div key={deal.id} style={{ padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.08)', ...wrap }}>
                <div style={{ fontWeight: 600 }}>{deal.name} · {deal.status}</div>
                <div style={label}>
                  {[usd(deal.amountUsd), deal.stageName, deal.expectedCloseChicago ? `closes ${deal.expectedCloseChicago}` : null,
                    deal.closedAt ? `closed ${new Date(deal.closedAt).toLocaleDateString()}` : null,
                    deal.lostReason, deal.wonReason].filter(Boolean).join(' · ')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}