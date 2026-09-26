import { useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type TerritoryExclusivity } from '../lib/api.js';

const STATUS_COLORS: Record<string, string> = {
  available: '#6a9f78',
  reserved: '#c9a84a',
  sold: '#c45c66',
  released: '#7b8ab8',
};

const blankForm = {
  name: '',
  exclusivityType: 'industry',
  industry: '',
  geographyType: 'metro',
  geographyValue: '',
  status: 'available',
  reservedForCompany: '',
  soldToCompany: '',
  ownerContact: '',
  notes: '',
} satisfies Partial<TerritoryExclusivity> & Record<string, string>;

export function TerritoryAvailabilityPanel() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [industry, setIndustry] = useState('');
  const [geography, setGeography] = useState('');
  const [form, setForm] = useState(blankForm);

  const { data, isLoading } = useQuery({
    queryKey: ['territories', status, industry, geography],
    queryFn: () => api.territories.list({
      ...(status ? { status } : {}),
      ...(industry ? { industry } : {}),
      ...(geography ? { geography } : {}),
      limit: 300,
    }),
    refetchInterval: 15000,
  });

  const create = useMutation({
    mutationFn: () => api.territories.create(cleanForm(form)),
    onSuccess: () => {
      setForm(blankForm);
      queryClient.invalidateQueries({ queryKey: ['territories'] });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, nextStatus }: { id: string; nextStatus: TerritoryExclusivity['status'] }) =>
      api.territories.update(id, { status: nextStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['territories'] }),
  });

  const territories = data?.territories ?? [];
  const byStatus = data?.byStatus ?? {};
  const visibleIndustries = useMemo(
    () => [...new Set(territories.map((t) => t.industry).filter((value): value is string => Boolean(value)))].sort(),
    [territories],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="glass-card" style={{ padding: 16, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-apex-text)' }}>
          Territory Availability
        </div>
        {['available', 'reserved', 'sold', 'released'].map((key) => (
          <div
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 6,
              background: `${STATUS_COLORS[key]}18`,
              border: `1px solid ${STATUS_COLORS[key]}44`,
              color: STATUS_COLORS[key],
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLORS[key] }} />
            {key}: {byStatus[key] ?? 0}
          </div>
        ))}
      </div>

      <div className="glass-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={status} onChange={(event) => setStatus(event.target.value)} style={fieldStyle}>
            <option value="">All statuses</option>
            <option value="available">Available</option>
            <option value="reserved">Reserved</option>
            <option value="sold">Sold</option>
            <option value="released">Released</option>
          </select>
          <input value={industry} onChange={(event) => setIndustry(event.target.value)} placeholder="Industry" list="territory-industries" style={fieldStyle} />
          <datalist id="territory-industries">
            {visibleIndustries.map((value) => <option key={value} value={value} />)}
          </datalist>
          <input value={geography} onChange={(event) => setGeography(event.target.value)} placeholder="Geography" style={fieldStyle} />
        </div>

        <div className="apex-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
          <input value={form.name} onChange={(event) => setFormValue('name', event.target.value, setForm)} placeholder="Display name" style={fieldStyle} />
          <select value={form.exclusivityType} onChange={(event) => setFormValue('exclusivityType', event.target.value, setForm)} style={fieldStyle}>
            <option value="industry">Industry exclusive</option>
            <option value="territory">Territory exclusive</option>
          </select>
          <input value={form.industry} onChange={(event) => setFormValue('industry', event.target.value, setForm)} placeholder="Industry" style={fieldStyle} />
          <select value={form.geographyType} onChange={(event) => setFormValue('geographyType', event.target.value, setForm)} style={fieldStyle}>
            <option value="metro">Metro</option>
            <option value="county">County</option>
            <option value="zip">ZIP group</option>
            <option value="dma">DMA</option>
            <option value="radius">Radius</option>
            <option value="custom">Custom</option>
          </select>
          <input value={form.geographyValue} onChange={(event) => setFormValue('geographyValue', event.target.value, setForm)} placeholder="Precise geography" style={fieldStyle} />
          <select value={form.status} onChange={(event) => setFormValue('status', event.target.value, setForm)} style={fieldStyle}>
            <option value="available">Available</option>
            <option value="reserved">Reserved</option>
            <option value="sold">Sold</option>
            <option value="released">Released</option>
          </select>
          <input value={form.reservedForCompany} onChange={(event) => setFormValue('reservedForCompany', event.target.value, setForm)} placeholder="Reserved for" style={fieldStyle} />
          <input value={form.soldToCompany} onChange={(event) => setFormValue('soldToCompany', event.target.value, setForm)} placeholder="Sold to" style={fieldStyle} />
        </div>
        <textarea value={form.notes} onChange={(event) => setFormValue('notes', event.target.value, setForm)} placeholder="Notes, boundaries, contract caveats" rows={2} style={{ ...fieldStyle, width: '100%', boxSizing: 'border-box' }} />
        <div>
          <button className="btn-primary" onClick={() => create.mutate()} disabled={create.isPending || !form.name || !form.geographyValue}>
            Add Territory
          </button>
          {create.isError && (
            <span style={{ marginLeft: 10, color: 'var(--color-apex-red)', fontSize: 12 }}>
              {create.error instanceof Error ? create.error.message : 'Could not save territory'}
            </span>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--color-apex-muted)' }}>Loading territories...</div>
        ) : territories.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--color-apex-muted)' }}>No territory records match the current filters.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-apex-line)' }}>
                  {['Name', 'Exclusivity', 'Geography', 'Holder', 'Status'].map((head) => (
                    <th key={head} style={{ padding: '9px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontSize: 10, textTransform: 'uppercase' }}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {territories.map((territory) => (
                  <tr key={territory.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 12px', color: 'var(--color-apex-text)', fontWeight: 650 }}>{territory.name}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-apex-muted)' }}>
                      {territory.exclusivityType === 'industry' ? territory.industry : 'Full territory'}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-apex-muted)' }}>
                      {territory.geographyType}: {territory.geographyValue}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--color-apex-muted)' }}>
                      {territory.soldToCompany || territory.reservedForCompany || 'Open'}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <select
                        value={territory.status}
                        onChange={(event) => update.mutate({ id: territory.id, nextStatus: event.target.value as TerritoryExclusivity['status'] })}
                        style={{
                          ...fieldStyle,
                          color: STATUS_COLORS[territory.status],
                          borderColor: `${STATUS_COLORS[territory.status]}66`,
                          minWidth: 118,
                        }}
                      >
                        <option value="available">Available</option>
                        <option value="reserved">Reserved</option>
                        <option value="sold">Sold</option>
                        <option value="released">Released</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function setFormValue(
  key: keyof typeof blankForm,
  value: string,
  setForm: Dispatch<SetStateAction<typeof blankForm>>,
) {
  setForm((current) => ({ ...current, [key]: value }));
}

function cleanForm(form: typeof blankForm): Partial<TerritoryExclusivity> {
  return {
    ...form,
    industry: form.exclusivityType === 'industry' ? form.industry : null,
    reservedForCompany: form.reservedForCompany || null,
    soldToCompany: form.soldToCompany || null,
    ownerContact: form.ownerContact || null,
    notes: form.notes || null,
    geographyDefinition: {},
  } as Partial<TerritoryExclusivity>;
}

const fieldStyle: CSSProperties = {
  minWidth: 0,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--color-apex-line)',
  background: 'rgba(0,0,0,0.28)',
  color: 'var(--color-apex-text)',
  fontSize: 12,
};
