import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EmailCampaignProgress, type EmailSendRow } from '../lib/api.js';
import { Play, Pause, X, ChevronDown, ChevronRight, Mail, Eye } from 'lucide-react';

// The send path (start_email_campaign / send_email_campaign_batch) has run as
// an agent-only tool chain since 2026-09-06 — this is the first place a human
// can see it or stop one. Unlike CampaignsPanel (a territory hunt with no
// natural funnel), an email campaign IS a funnel: queued -> sent -> delivered
// -> opened/clicked, with bounced/complained/failed/suppressed as the ways a
// target leaves it. The bar below renders exactly that shape instead of a
// single percentage, because "40% complete" hides whether the 40% actually
// reached anyone.

const STATUS_COLOR: Record<string, string> = {
  draft: '#7d8a91',
  running: '#5a9eae',
  paused: '#c9a84a',
  completed: '#6a9f78',
  cancelled: '#7d8a91',
};

const FUNNEL_STEPS: Array<{ key: keyof EmailCampaignProgress; label: string; color: string }> = [
  { key: 'queued', label: 'Queued', color: 'rgba(255,255,255,0.14)' },
  { key: 'sent', label: 'Sent', color: '#5a9eae' },
  { key: 'delivered', label: 'Delivered', color: '#6a9f78' },
  { key: 'opened', label: 'Opened', color: '#8fb8a8' },
  { key: 'clicked', label: 'Clicked', color: '#c9a84a' },
  { key: 'bounced', label: 'Bounced', color: '#c45c66' },
  { key: 'complained', label: 'Complained', color: '#a23b4a' },
  { key: 'failed', label: 'Failed', color: '#c45c66' },
  { key: 'suppressed', label: 'Suppressed', color: 'rgba(255,255,255,0.07)' },
];

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function FunnelBar({ campaign }: { campaign: EmailCampaignProgress }) {
  const total = campaign.totalTargets || 1;
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.06)' }}>
      {FUNNEL_STEPS.map((step) => {
        const value = campaign[step.key] as number;
        if (!value) return null;
        return (
          <div
            key={step.key}
            title={`${step.label}: ${value}`}
            style={{ width: `${Math.max(0, Math.min(100, (value / total) * 100))}%`, background: step.color }}
          />
        );
      })}
    </div>
  );
}

/** One recipient row, expandable to the exact resolved subject/body — the
 *  real content that was queued or sent, not the raw template. This is the
 *  operator's window into what a campaign actually says, in place of a CC on
 *  every send (which would put a personal address in every recipient's
 *  headers and doesn't give a historical record for sends already delivered). */
function SendRow({ send }: { send: EmailSendRow }) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(send.body);

  return (
    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <button
        onClick={() => hasBody && setOpen(!open)}
        disabled={!hasBody}
        style={{
          display: 'flex',
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          padding: '4px 0',
          background: 'none',
          border: 'none',
          color: 'var(--color-apex-muted)',
          cursor: hasBody ? 'pointer' : 'default',
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          {hasBody && (open ? <ChevronDown size={11} /> : <Eye size={11} style={{ opacity: 0.6 }} />)}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {send.toName ? `${send.toName} <${send.toEmail}>` : send.toEmail}
          </span>
        </span>
        <span style={{ flex: 'none', color: STATUS_COLOR[send.status] ?? 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
          {send.status}
        </span>
      </button>
      {open && hasBody && (
        <div style={{ margin: '2px 0 10px', padding: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--color-apex-text)', fontWeight: 600, marginBottom: 6 }}>{send.subject}</div>
          <div
            style={{ fontSize: 11, color: 'var(--color-apex-muted)', lineHeight: 1.5, maxHeight: 260, overflowY: 'auto' }}
            // Content is APEX's own resolved template output, not third-party
            // HTML — this is exactly what Resend was sent.
            dangerouslySetInnerHTML={{ __html: send.body ?? '' }}
          />
          {send.errorMessage && (
            <div style={{ fontSize: 10, color: '#c45c66', marginTop: 6 }}>{send.errorMessage}</div>
          )}
        </div>
      )}
    </div>
  );
}

function EmailCampaignCard({ campaign }: { campaign: EmailCampaignProgress }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ['email-campaign', campaign.campaignId],
    queryFn: () => api.emailCampaigns.get(campaign.campaignId),
    enabled: expanded,
    refetchInterval: expanded ? 5000 : false,
  });

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') => api.emailCampaigns.control(campaign.campaignId, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-campaigns'] });
      qc.invalidateQueries({ queryKey: ['email-campaign', campaign.campaignId] });
    },
  });

  const color = STATUS_COLOR[campaign.status] ?? '#7d8a91';
  const isLive = campaign.status === 'draft' || campaign.status === 'running' || campaign.status === 'paused';
  const nonDelivered = campaign.bounced + campaign.complained + campaign.failed;

  return (
    <motion.div className="glass-card" style={{ padding: 18, borderColor: `${color}40` }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: 'none', border: 'none', color: 'var(--color-apex-muted)', cursor: 'pointer', padding: 0, marginTop: 2 }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>{campaign.name}</div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 2 }}>
            {campaign.sentCount + campaign.failedCount} of {campaign.totalTargets} attempted
            {nonDelivered > 0 && ` · ${nonDelivered} bounced/complained/failed`}
            {` · last activity ${formatWhen(campaign.lastProgressAt ?? campaign.createdAt)}`}
          </div>
        </div>
        <span
          style={{
            padding: '3px 9px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            background: `${color}1f`,
            color,
            border: `1px solid ${color}55`,
            whiteSpace: 'nowrap',
          }}
        >
          {campaign.status}
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <FunnelBar campaign={campaign} />
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 12 }}>
        {FUNNEL_STEPS.filter((s) => (campaign[s.key] as number) > 0).map((s) => (
          <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
            {s.label} <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-apex-text)' }}>{campaign[s.key] as number}</span>
          </span>
        ))}
      </div>

      {isLive && (
        <div style={{ display: 'flex', gap: 8 }}>
          {campaign.status === 'paused' ? (
            <button className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }} onClick={() => control.mutate('resume')} disabled={control.isPending}>
              <Play size={13} /> Resume
            </button>
          ) : (
            <button className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }} onClick={() => control.mutate('pause')} disabled={control.isPending}>
              <Pause size={13} /> Pause
            </button>
          )}
          <button className="btn-danger" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }} onClick={() => control.mutate('cancel')} disabled={control.isPending}>
            <X size={13} /> Cancel
          </button>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {!detail ? (
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Loading…</div>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginBottom: 10 }}>
                <strong style={{ color: 'var(--color-apex-text)' }}>Subject:</strong> {detail.campaign.subjectTemplate}
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginBottom: 6, opacity: 0.8 }}>
                Click a recipient to preview the exact email it received.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {detail.sends.slice(0, 25).map((send) => <SendRow key={send.id} send={send} />)}
                {detail.sends.length === 0 && <div style={{ fontSize: 11, color: 'var(--color-apex-muted)' }}>No sends recorded yet.</div>}
              </div>
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}

export function EmailCampaignsPanel() {
  const { data: campaigns = [] } = useQuery({
    queryKey: ['email-campaigns'],
    queryFn: () => api.emailCampaigns.list(),
    refetchInterval: 5000,
  });

  const live = campaigns.filter((c) => c.status === 'draft' || c.status === 'running' || c.status === 'paused');
  const finished = campaigns.filter((c) => c.status === 'completed' || c.status === 'cancelled');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--color-apex-muted)' }}>
        {live.length} active · {finished.length} finished
      </div>

      {campaigns.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--color-apex-muted)',
            padding: '60px 20px',
            border: '1px dashed rgba(255,255,255,0.08)',
            borderRadius: 12,
          }}
        >
          <Mail size={28} style={{ opacity: 0.6, marginBottom: 8 }} />
          <div style={{ fontSize: 14, fontWeight: 500 }}>No email campaigns yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Ask Apex to email a lead campaign's targets — it enqueues and sends under approval, and shows up here.
          </div>
        </div>
      )}

      {live.map((c) => <EmailCampaignCard key={c.campaignId} campaign={c} />)}
      {finished.length > 0 && live.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 6 }}>
          Finished
        </div>
      )}
      {finished.map((c) => <EmailCampaignCard key={c.campaignId} campaign={c} />)}
    </div>
  );
}
