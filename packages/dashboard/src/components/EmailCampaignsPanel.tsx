import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EmailCampaignProgress } from '../lib/api.js';
import { Play, Pause, X, ChevronDown, ChevronRight, Mail } from 'lucide-react';

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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {detail.sends.slice(0, 25).map((send) => (
                  <div
                    key={send.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 11,
                      padding: '4px 0',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      color: 'var(--color-apex-muted)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {send.toName ? `${send.toName} <${send.toEmail}>` : send.toEmail}
                    </span>
                    <span style={{ flex: 'none', color: STATUS_COLOR[send.status] ?? 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
                      {send.status}
                    </span>
                  </div>
                ))}
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
