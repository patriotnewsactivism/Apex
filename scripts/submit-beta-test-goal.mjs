import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const PASSWORD = envContent.match(/^APEX_ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim();
const BASE = 'https://apex.donmatthews.live';

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: PASSWORD }),
  signal: AbortSignal.timeout(15000),
});
const { token } = await r.json();
console.log('Auth OK');

const goal = {
  title: 'Beta Test BuildMyBot.app — Full Platform QA Sweep',
  description: `Conduct a comprehensive beta test of buildmybot.app (www.buildmybot.app). Act as beta testers exploring every feature of the platform. Test the following areas and report findings:

1. **Landing Page & Sign-up**: Visit buildmybot.app, review the marketing copy, test the sign-up flow, verify pricing tiers are displayed correctly (Free $0, Starter $29, Pro $99, Executive $199, Enterprise $499).

2. **Bot Builder**: After login, test the bot creation flow. Create a test bot, configure its personality/knowledge, verify the embed widget works.

3. **Lead Capture**: Test the lead capture form at /api/leads/capture. Submit test leads and verify they appear in the CRM.

4. **CRM Dashboard**: Navigate the CRM interface. Verify leads are displayed, can be filtered, exported as CSV.

5. **Analytics**: Check the analytics dashboard for real data (or appropriate empty states).

6. **Voice Agent**: Review the voice agent configuration page. Check that Twilio integration settings are accessible.

7. **Reseller/Partner Portal**: Navigate the reseller portal. Verify commission tiers are displayed (Bronze 20% through Platinum 50%).

8. **Health Check**: Use the buildmybot_health_check tool to verify the API is responding. Use buildmybot_status to review today's AI workforce activity.

9. **Settings/Integrations**: Check what integrations are available (webhooks, channels, phone numbers).

10. **Mobile Responsiveness**: Note any obvious mobile responsiveness issues.

For each area, report: what works, what's broken, what's missing, and any UX issues. Use webSearch and fetchUrl to access the public pages. Use buildmybot_health_check and buildmybot_status tools for API-level testing. Save a comprehensive test report as a task result.`,
  priority: 8,
};

const res = await fetch(`${BASE}/api/goals`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(goal),
  signal: AbortSignal.timeout(60000),
});

if (res.ok) {
  const data = await res.json();
  console.log('Goal submitted:', data.goalId ? 'OK (' + data.goalId.slice(0, 8) + ')' : 'FAILED');
} else {
  console.log('Failed:', res.status);
  const text = await res.text().catch(() => '');
  console.log('Error:', text.slice(0, 300));
}
