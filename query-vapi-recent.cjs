(async () => {
  const key = process.env.VAPI_API_KEY;
  const phoneId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!key) throw new Error('VAPI_API_KEY unavailable');
  const headers = { authorization: `Bearer ${key}` };
  const callsRes = await fetch('https://api.vapi.ai/call?limit=20', { headers });
  const calls = await callsRes.json();
  const recent = Array.isArray(calls) ? calls.map(c => ({
    id: c.id,
    status: c.status,
    endedReason: c.endedReason,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    customerNumber: c.customer?.number,
    phoneNumberId: c.phoneNumberId,
  })) : calls;
  let phone = null;
  if (phoneId) {
    const phoneRes = await fetch(`https://api.vapi.ai/phone-number/${phoneId}`, { headers });
    const p = await phoneRes.json();
    phone = { httpStatus: phoneRes.status, id: p.id, number: p.number, provider: p.provider, status: p.status, assistantId: p.assistantId };
  }
  console.log(JSON.stringify({ callsHttpStatus: callsRes.status, recent, phone }, null, 2));
})().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
