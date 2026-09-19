const token = process.env.APEX_ADMIN_TOKEN;
if (!token) throw new Error('APEX_ADMIN_TOKEN is not available');
const response = await fetch('https://apex.donmatthews.live/api/sales-ops/call', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    customerNumber: '+18328804970',
    customerName: 'Matthew',
    firstMessage: 'Hi Matthew, this is a brief APEX voice-path test. You can hang up after you hear this.',
    assistantPrompt: 'This is a controlled APEX voice-path test. Briefly identify it as a test and keep the call short.',
  }),
});
const body = await response.text();
console.log(JSON.stringify({ httpStatus: response.status, body }, null, 2));
