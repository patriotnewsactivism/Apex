import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Stethoscope,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api.js';
import type { DiagnosticFinding, DiagnosticSeverity } from '../lib/api.js';
import { copyText } from '../lib/clipboard.js';

/**
 * The dashboard face of `GET /api/diagnostics`.
 *
 * The endpoint already answers "what is wrong with APEX right now", but an
 * endpoint you have to curl is not an answer an operator can reach from a
 * phone at 2am — which is the moment this is actually needed. Every finding
 * carries the action that resolves it, so the panel leads with the action
 * rather than burying it behind a disclosure.
 */

const SEVERITY = {
  critical: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.35)', label: 'Critical' },
  warning: { color: '#eab308', bg: 'rgba(234, 179, 8, 0.12)', border: 'rgba(234, 179, 8, 0.35)', label: 'Warning' },
  ok: { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.25)', label: 'OK' },
} as const satisfies Record<DiagnosticSeverity, unknown>;

function SeverityIcon({ severity, size = 16 }: { severity: DiagnosticSeverity; size?: number }) {
  const color = SEVERITY[severity].color;
  if (severity === 'critical') return <AlertOctagon size={size} color={color} />;
  if (severity === 'warning') return <AlertTriangle size={size} color={color} />;
  return <CheckCircle2 size={size} color={color} />;
}

function FindingRow({ finding }: { finding: DiagnosticFinding }) {
  const s = SEVERITY[finding.severity];
  return (
    <div
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <span style={{ flexShrink: 0, paddingTop: 1 }}>
        <SeverityIcon severity={finding.severity} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#f1f5f9',
            overflowWrap: 'anywhere',
          }}
        >
          {finding.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: '#94a3b8',
            marginTop: 2,
            overflowWrap: 'anywhere',
          }}
        >
          {finding.detail}
        </div>
        {finding.action && (
          <div
            style={{
              fontSize: 12,
              color: s.color,
              marginTop: 6,
              paddingLeft: 10,
              borderLeft: `2px solid ${s.border}`,
              overflowWrap: 'anywhere',
            }}
          >
            {finding.action}
          </div>
        )}
      </div>
    </div>
  );
}

export function DiagnosticsPanel() {
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.diagnostics.get(),
    refetchInterval: 15_000,
  });

  const [copied, setCopied] = useState(false);
  const [showOk, setShowOk] = useState(false);

  // Copy the server's own text rendering rather than re-deriving one here:
  // the report an operator pastes into an issue should be the same bytes the
  // endpoint produces, not a second format that can drift from it.
  const copyReport = useCallback(async () => {
    try {
      await copyText(await api.diagnostics.text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* the button simply does not confirm; the panel above still shows why */
    }
  }, []);

  // Validate rather than trust. This panel renders on the one view an operator
  // opens when things are already broken, so a malformed or unexpected response
  // must degrade to "unreachable" — never throw and blank the page behind it.
  const findings: DiagnosticFinding[] = Array.isArray(data?.findings)
    ? data.findings.filter((f): f is DiagnosticFinding => Boolean(f) && f.severity in SEVERITY)
    : [];
  const problems = findings.filter((f) => f.severity !== 'ok');
  const healthy = findings.filter((f) => f.severity === 'ok');
  const status: DiagnosticSeverity =
    data?.status && data.status in SEVERITY ? data.status : 'ok';
  const s = SEVERITY[status];
  const build = data?.build;
  const sha = typeof build?.sha === 'string' ? build.sha.slice(0, 8) : '?';
  const upMin = Number.isFinite(build?.uptimeSeconds)
    ? Math.floor((build as { uptimeSeconds: number }).uptimeSeconds / 60)
    : null;
  const usable = findings.length > 0;

  return (
    <div className="glass-card" style={{ padding: 16, marginBottom: 24, maxWidth: '100%' }}>
      <div
        className="apex-toolbar"
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}
      >
        <Stethoscope size={18} color={s.color} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>Diagnostics</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            {error
              ? 'Unreachable'
              : !data
                ? 'Checking...'
                : !usable
                  ? 'No checks reported'
                  : `${problems.length === 0 ? 'No problems found' : `${problems.length} to look at`} · ${sha}${upMin === null ? '' : ` · up ${upMin}m`}`}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }} />
        <button
          className="btn-secondary apex-tap"
          onClick={copyReport}
          disabled={!data}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
          title="Copy the full report as plain text"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy report'}
        </button>
        <button
          className="btn-secondary apex-tap"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
          title="Re-run the checks now"
        >
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} /> Recheck
        </button>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: '#ef4444', overflowWrap: 'anywhere' }}>
          Could not reach /api/diagnostics: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <AnimatePresence initial={false}>
          {problems.map((f) => (
            <motion.div
              key={f.code}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <FindingRow finding={f} />
            </motion.div>
          ))}
        </AnimatePresence>

        {data && usable && problems.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#22c55e' }}>
            <CheckCircle2 size={16} /> All {findings.length} checks pass.
          </div>
        )}

        {data && !usable && !error && (
          <div style={{ fontSize: 12, color: '#94a3b8' }}>
            /api/diagnostics answered, but reported no checks.
          </div>
        )}

        {healthy.length > 0 && (
          <>
            <button
              className="apex-tap"
              onClick={() => setShowOk((v) => !v)}
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                color: '#64748b',
                fontSize: 11,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: 0,
              }}
            >
              <ChevronDown
                size={12}
                style={{ transform: showOk ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}
              />
              {showOk ? 'Hide' : 'Show'} {healthy.length} passing check{healthy.length !== 1 ? 's' : ''}
            </button>
            {showOk && healthy.map((f) => <FindingRow key={f.code} finding={f} />)}
          </>
        )}
      </div>
    </div>
  );
}
