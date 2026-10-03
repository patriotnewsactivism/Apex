import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CalendarSettingsPayload } from '../lib/api.js';
import { CalendarClock } from 'lucide-react';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarSettingsPanel() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['calendar', 'settings'],
    queryFn: () => api.calendar.settings(),
  });
  const calendarsQuery = useQuery({
    queryKey: ['calendar', 'google-calendars'],
    queryFn: () => api.calendar.googleCalendars(),
    enabled: Boolean(settingsQuery.data?.status.googleConnected),
    retry: false,
  });
  const [draft, setDraft] = useState<CalendarSettingsPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data?.settings) setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data?.settings]);

  const save = useMutation({
    mutationFn: (settings: CalendarSettingsPayload) => api.calendar.saveSettings(settings),
    onSuccess: (result) => {
      setDraft(result.settings);
      setMessage('Calendar settings saved.');
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
    onError: (err) => setMessage(err instanceof Error ? err.message : 'Save failed'),
  });

  const connect = useMutation({
    mutationFn: () => api.calendar.googleStart(),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
    onError: (err) => setMessage(err instanceof Error ? err.message : 'Google connect failed'),
  });

  const status = settingsQuery.data?.status;
  const settings = draft;

  return (
    <div style={{ background: 'var(--color-apex-card)', border: '1px solid rgba(90,158,174,0.15)', borderRadius: 12, padding: 20, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <CalendarClock size={18} color="#c9a84a" />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-apex-text)' }}>Calendar booking</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--color-apex-muted)', margin: '0 0 14px', lineHeight: 1.45 }}>
        Google Calendar is the master. Public links stay on Cal.com. Which account and which calendars count as busy are chosen here.
      </p>

      {settingsQuery.isError && (
        <div style={{ fontSize: 12, color: 'var(--color-apex-red)', marginBottom: 10 }}>
          {settingsQuery.error instanceof Error ? settingsQuery.error.message : 'Calendar settings unavailable'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 14, minWidth: 0 }}>
        <StatusLine label="Google" value={status?.googleConnected ? (status.googleAccountEmail ?? 'connected') : 'not connected'} />
        <StatusLine label="OAuth client" value={status?.oauthConfigured ? 'configured' : 'missing client id/secret'} />
        <StatusLine label="Redirect URI" value={status?.redirectUriConfigured ? 'set' : 'missing'} />
        <StatusLine label="Cal.com" value={status?.calConfigured ? 'key and event type set' : 'not configured'} />
        <StatusLine label="Cal.com webhook" value={status?.calWebhookSecretSet ? 'secret set' : 'secret missing'} />
        <StatusLine label="Busy calendars" value={status ? `${status.busyCalendarSource}` : '—'} />
        <StatusLine label="Appointment schedules" value="manual fallback only" />
      </div>

      <button type="button" onClick={() => connect.mutate()} disabled={connect.isPending} style={buttonStyle}>
        {connect.isPending ? 'Opening Google…' : 'Connect Google account'}
      </button>

      {settings && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16, minWidth: 0 }}>
          <label style={labelStyle}>
            Operator name
            <input value={settings.operatorDisplayName} onChange={(event) => setDraft({ ...settings, operatorDisplayName: event.target.value })} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Timezone
            <input value={settings.timezone} onChange={(event) => setDraft({ ...settings, timezone: event.target.value })} style={inputStyle} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            <NumberField label="Buffer before (min)" value={settings.bufferBeforeMinutes} onChange={(value) => setDraft({ ...settings, bufferBeforeMinutes: value })} />
            <NumberField label="Buffer after (min)" value={settings.bufferAfterMinutes} onChange={(value) => setDraft({ ...settings, bufferAfterMinutes: value })} />
            <NumberField label="Max meetings / day" value={settings.maxMeetingsPerDay} onChange={(value) => setDraft({ ...settings, maxMeetingsPerDay: value })} />
            <NumberField label="Minimum notice (min)" value={settings.minimumNoticeMinutes} onChange={(value) => setDraft({ ...settings, minimumNoticeMinutes: value })} />
            <NumberField label="Hold length (min)" value={settings.holdMinutes} onChange={(value) => setDraft({ ...settings, holdMinutes: value })} />
            <NumberField label="Slot length (min)" value={settings.slotMinutes} onChange={(value) => setDraft({ ...settings, slotMinutes: value })} />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginBottom: 6 }}>Working hours</div>
            {settings.workingHours.map((window, index) => (
              <div key={`${window.day}-${index}`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <select
                  value={window.day}
                  onChange={(event) => updateWindow(settings, index, { day: Number(event.target.value) }, setDraft)}
                  style={inputStyle}
                >
                  {DAY_LABELS.map((label, day) => <option key={label} value={day}>{label}</option>)}
                </select>
                <input value={window.start} onChange={(event) => updateWindow(settings, index, { start: event.target.value }, setDraft)} style={inputStyle} />
                <input value={window.end} onChange={(event) => updateWindow(settings, index, { end: event.target.value }, setDraft)} style={inputStyle} />
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)', marginBottom: 6 }}>Busy calendars</div>
            {(calendarsQuery.data?.calendars ?? []).map((calendar) => {
              const checked = settings.busyCalendarIds.includes(calendar.id);
              return (
                <label key={calendar.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--color-apex-text)', marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const busyCalendarIds = checked
                        ? settings.busyCalendarIds.filter((id) => id !== calendar.id)
                        : [...settings.busyCalendarIds, calendar.id];
                      setDraft({ ...settings, busyCalendarIds });
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{calendar.summary}{calendar.primary ? ' (primary)' : ''}</span>
                </label>
              );
            })}
            {!status?.googleConnected && <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Connect Google to choose calendars. Until then, free/busy uses the booking calendar or primary.</div>}
            <label style={{ ...labelStyle, marginTop: 8 }}>
              Booking calendar id
              <input
                value={settings.bookingCalendarId ?? ''}
                placeholder="primary"
                onChange={(event) => setDraft({ ...settings, bookingCalendarId: event.target.value.trim() || null })}
                style={inputStyle}
              />
            </label>
          </div>

          <label style={labelStyle}>
            No-book blocks (one per line: start ISO, end ISO, optional label)
            <textarea
              value={settings.noBookBlocks.map((block) => [block.start, block.end, block.label ?? ''].filter(Boolean).join(' ')).join('\n')}
              onChange={(event) => setDraft({ ...settings, noBookBlocks: parseBlocks(event.target.value) })}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>

          <label style={labelStyle}>
            Agent colors (one per line: agent key, #hex, Google color id 1-11)
            <textarea
              value={Object.entries(settings.agentColors).map(([key, color]) => `${key} ${color.hex} ${color.googleColorId}`).join('\n')}
              onChange={(event) => setDraft({ ...settings, agentColors: parseColors(event.target.value) })}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>

          <button type="button" onClick={() => save.mutate(settings)} disabled={save.isPending} style={buttonStyle}>
            {save.isPending ? 'Saving…' : 'Save calendar settings'}
          </button>
        </div>
      )}
      {message && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-apex-muted)' }}>{message}</div>}
    </div>
  );
}

function updateWindow(
  settings: CalendarSettingsPayload,
  index: number,
  patch: Partial<CalendarSettingsPayload['workingHours'][number]>,
  setDraft: (next: CalendarSettingsPayload) => void,
) {
  const workingHours = settings.workingHours.map((window, item) => item === index ? { ...window, ...patch } : window);
  setDraft({ ...settings, workingHours });
}

function parseBlocks(text: string): CalendarSettingsPayload['noBookBlocks'] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [start, end, ...label] = line.split(/\s+/);
    return { id: `block-${index + 1}`, start: start ?? '', end: end ?? '', label: label.join(' ') || undefined };
  }).filter((block) => block.start && block.end);
}

function parseColors(text: string): CalendarSettingsPayload['agentColors'] {
  const colors: CalendarSettingsPayload['agentColors'] = {};
  for (const line of text.split('\n')) {
    const [key, hex, googleColorId] = line.trim().split(/\s+/);
    if (!key || !hex || !googleColorId) continue;
    colors[key] = { hex, googleColorId };
  }
  return colors;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0, padding: 8, borderRadius: 8, border: '1px solid var(--color-apex-line)' }}>
      <div style={{ fontSize: 10, color: 'var(--color-apex-muted)' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--color-apex-text)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label style={labelStyle}>
      {label}
      <input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} style={inputStyle} />
    </label>
  );
}

const labelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 4,
  fontSize: 12,
  color: 'var(--color-apex-muted)',
  minWidth: 0,
};

const inputStyle = {
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box' as const,
  minWidth: 0,
  background: 'rgba(255,255,255,0.03)',
  color: 'var(--color-apex-text)',
  border: '1px solid var(--color-apex-line)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
};

const buttonStyle = {
  alignSelf: 'flex-start' as const,
  minHeight: 36,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-apex-brass)',
  background: 'transparent',
  color: 'var(--color-apex-brass)',
  cursor: 'pointer',
  fontSize: 12,
};
