/**
 * CRM phase 3: the intelligence layer.
 *
 * A reading of a contact (a paragraph and the next step, written from that
 * contact's own history), the score that says how warm a contact is and why,
 * saved views, and the reports page.
 *
 * Two things this panel refuses to fake: a summary that no model produced (the
 * generate button reports the model's absence rather than showing a blank
 * paragraph), and a stale summary (it says so and offers to regenerate).
 */
import { useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CrmContactFilters, type CrmScore, type CrmSavedView } from '../lib/api.js';
import { LifecycleBadge } from './CrmOperatorPanels.js';

const wrap: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0, maxWidth: '100%' };
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const label: CSSProperties = { fontSize: 12, color: 'var(--color-apex-muted)' };
const input: CSSProperties = { flex: '1 1 140px', minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)' };
const button: CSSProperties = { padding: '6px 10px' };

const BAND_COLORS: Record<string, string> = { cold: '#8a8f98', warm: '#c9a84a', hot: '#c45c66' };

export function ScoreBadge({ score }: { score: CrmScore | null | undefined }) {
  if (!score) return null;
  return (
    <span
      title={(score.reasons ?? []).map((reason) => `${reason.points > 0 ? '+' : ''}${reason.points} ${reason.label}`).join('\n') || score.blocked || 'no score'}
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 4,
        color: BAND_COLORS[score.band] ?? '#8a8f98',
        border: `1px solid ${BAND_COLORS[score.band] ?? '#8a8f98'}`,
      }}
    >
      {score.score} {score.band}
    </span>
  );
}

export function ScoreBreakdown({ score }: { score: CrmScore | null | undefined }) {
  if (!score) return <div style={label}>No score for this contact.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {score.blocked && <div style={{ ...wrap, fontSize: 13, color: '#c45c66' }}>{score.blocked}</div>}
      {score.reasons.map((reason) => (
        <div key={reason.label} style={{ ...wrap, fontSize: 12 }}>
          <strong>{reason.points > 0 ? `+${reason.points}` : reason.points}</strong> {reason.label}
        </div>
      ))}
    </div>
  );
}

/** The paragraph and the next step, with its age and its staleness on the card. */
export function ContactInsightPanel({ contactId }: { contactId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const insight = useQuery({
    queryKey: ['crm-insight', contactId],
    queryFn: () => api.crm.insight.get(contactId),
  });
  const generate = useMutation({
    mutationFn: () => api.crm.insight.generate(contactId),
    onSuccess: () => {
      setNotice('Summary generated from this contact\'s history.');
      queryClient.invalidateQueries({ queryKey: ['crm-insight', contactId] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Could not generate the summary.'),
  });

  const data = insight.data?.insight ?? null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Where this stands</div>
        <button type="button" style={button} disabled={generate.isPending} onClick={() => generate.mutate()}>
          {data ? 'Regenerate' : 'Generate'} (Matthew)
        </button>
      </div>
      {!data && !insight.isLoading && (
        <div style={label}>Nothing generated yet. The summary is written from this contact&apos;s own history.</div>
      )}
      {data && (
        <>
          <div style={{ ...wrap, fontSize: 13 }}>{data.summary}</div>
          <div style={{ ...wrap, fontSize: 13 }}>
            <strong>Next step:</strong> {data.nextStep}
          </div>
          <div style={label}>
            {`written by ${data.model ?? 'an unnamed model'} on ${new Date(data.generatedAt).toLocaleString()} from ${data.sourceEvents} history rows`}
            {data.stale ? ` · stale: ${data.currentEvents} rows now` : ''}
          </div>
        </>
      )}
      {notice && <div style={{ ...wrap, fontSize: 13 }}>{notice}</div>}
    </div>
  );
}

/**
 * Save the filters you are looking at, and reopen them later. A view is only a
 * filter set: applying one is the same as typing the filters in yourself.
 */
export function SavedViewsBar({ filters, onApply, onNotice }: {
  filters: CrmContactFilters;
  onApply: (filters: CrmContactFilters) => void;
  onNotice?: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const views = useQuery({ queryKey: ['crm-views', 'contacts'], queryFn: () => api.crm.views.list('contacts') });

  const say = (text: string) => {
    setMessage(text);
    onNotice?.(text);
  };
  const save = useMutation({
    mutationFn: () => api.crm.views.save({ name: name.trim(), scope: 'contacts', filters: filters as Record<string, unknown> }),
    onSuccess: (result) => {
      say(result.created ? `Saved view "${name.trim()}".` : `Updated view "${name.trim()}".`);
      setName('');
      queryClient.invalidateQueries({ queryKey: ['crm-views'] });
    },
    onError: (error) => say(error instanceof Error ? error.message : 'Could not save the view.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.crm.views.remove(id),
    onSuccess: () => {
      say('Saved view deleted.');
      queryClient.invalidateQueries({ queryKey: ['crm-views'] });
    },
    onError: (error) => say(error instanceof Error ? error.message : 'Could not delete the view.'),
  });

  const saved: CrmSavedView[] = views.data?.views ?? [];
  const activeCount = Object.values(filters).filter((value) => value !== undefined && value !== null && value !== '').length;

  return (
    <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <div style={row}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Saved views</div>
        <span style={label}>{activeCount} filter{activeCount === 1 ? '' : 's'} active now</span>
      </div>
      <div style={row}>
        <input aria-label="View name" placeholder="Name this view" value={name} onChange={(event) => setName(event.target.value)} style={input} />
        <button type="button" style={button} disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          Save current filters
        </button>
      </div>
      {saved.length === 0 && <div style={label}>No saved views yet.</div>}
      {saved.map((view) => (
        <div key={view.id} style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
          <button
            type="button"
            onClick={() => { onApply(view.filters as CrmContactFilters); say(`Applied view "${view.name}".`); }}
            style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, textAlign: 'left', cursor: 'pointer', ...wrap }}
          >
            <div style={{ fontWeight: 650 }}>{view.name}</div>
            <div style={label}>{Object.keys(view.filters ?? {}).length} filter{Object.keys(view.filters ?? {}).length === 1 ? '' : 's'}</div>
          </button>
          <button type="button" style={button} onClick={() => remove.mutate(view.id)}>Delete</button>
        </div>
      ))}
      {message && <div style={{ ...wrap, fontSize: 13 }}>{message}</div>}
    </div>
  );
}

function usd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function ReportsPanel() {
  const [days, setDays] = useState(90);
  const reports = useQuery({
    queryKey: ['crm-reports', days],
    queryFn: () => api.crm.reports({ days }),
  });
  const scored = useQuery({
    queryKey: ['crm-scored'],
    queryFn: () => api.crm.scored({ limit: 15, minScore: 1 }),
  });

  const data = reports.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%' }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={row}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Reports</div>
          <select aria-label="Window" value={String(days)} onChange={(event) => setDays(Number(event.target.value))} style={input}>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="180">Last 180 days</option>
            <option value="365">Last 365 days</option>
          </select>
          {data && <span style={label}>Window: {data.window.label} · America/Chicago</span>}
        </div>
        {reports.isError && <div style={wrap}>Could not load the reports.</div>}
        {data && (
          <div style={{ ...label }}>
            {data.revenue.openCount} open ({usd(data.revenue.openUsd)}) · {data.revenue.wonCount} won ({usd(data.revenue.wonUsd)}) ·{' '}
            {data.revenue.lostCount} lost ({usd(data.revenue.lostUsd)}) · average won {usd(data.revenue.averageWonUsd)} ·{' '}
            {usd(data.revenue.wonThisMonthUsd)} won this month
          </div>
        )}
      </div>

      {data && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Conversion by stage</div>
          <div style={label}>“Reached” is every deal that ever entered the stage, from the audit trail, not just the ones sitting there now.</div>
          {data.funnel.map((rowData) => (
            <div key={rowData.stageId ?? rowData.name} style={{ ...wrap, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6, fontSize: 13 }}>
              <strong>{rowData.name}</strong>{' '}
              {`${rowData.reached} reached · ${rowData.openNow} open (${usd(rowData.openValueUsd)})`}
              {rowData.conversionFromPrevious !== null ? ` · ${rowData.conversionFromPrevious}% of the previous stage` : ''}
            </div>
          ))}
          {data.funnel.length === 0 && <div style={label}>No pipeline stages yet.</div>}
        </div>
      )}

      {data && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Replies by channel</div>
          <div style={label}>{data.replies.totalReplies} replies from {data.replies.totalOutbound} outbound touches in this window.</div>
          {data.replies.byChannel.map((channel) => (
            <div key={channel.channel} style={{ ...wrap, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6, fontSize: 13 }}>
              <strong>{channel.channel}</strong> {`${channel.outbound} out · ${channel.replies} replies · ${channel.rate}%`}
            </div>
          ))}
          {data.replies.byChannel.length === 0 && <div style={label}>Nothing sent in this window.</div>}

          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8 }}>Replies by industry</div>
          {data.replies.byIndustry.map((industryRow) => (
            <div key={industryRow.industry} style={{ ...wrap, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6, fontSize: 13 }}>
              <strong>{industryRow.industry}</strong> {`${industryRow.outbound} out · ${industryRow.replies} replies · ${industryRow.rate}%`}
            </div>
          ))}
        </div>
      )}

      {data && data.revenue.lostReasons.length > 0 && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Why deals were lost</div>
          {data.revenue.lostReasons.map((reason) => (
            <div key={reason.reason} style={{ ...wrap, fontSize: 13 }}>
              {reason.reason}: {reason.count} ({usd(reason.valueUsd)})
            </div>
          ))}
        </div>
      )}

      <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Work these next</div>
        <div style={label}>Highest scoring contacts that are not on do-not-contact.</div>
        {(scored.data?.contacts ?? []).length === 0 && !scored.isLoading && <div style={label}>Nothing scored yet.</div>}
        {(scored.data?.contacts ?? []).map((contact) => (
          <div key={contact.contactId} style={{ ...row, justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
            <div style={{ ...wrap, flex: '1 1 220px' }}>
              <div style={{ fontWeight: 650 }}>{contact.name}</div>
              <div style={label}>
                {[contact.organizationName, contact.email ?? contact.phoneE164, contact.nextFollowUpAt ? `follow up ${new Date(contact.nextFollowUpAt).toLocaleDateString()}` : null]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
            <div style={row}>
              <LifecycleBadge stage={contact.lifecycleStage} />
              <ScoreBadge score={contact.score} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
