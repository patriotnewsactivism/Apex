import { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  BellRing,
  Bot,
  CalendarCheck,
  Check,
  CircleDollarSign,
  Clock3,
  Crosshair,
  Gauge,
  LockKeyhole,
  Mail,
  MessageSquareText,
  Network,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import './PublicLanding.css';

interface PublicLandingProps {
  onOperatorLogin: () => void;
}

interface DemoLead {
  company: string;
  industry: string;
  city: string;
  decisionMaker: string;
  contact: string;
  fitReason: string;
  strategy: string;
  emailSubject: string;
  emailBody: string;
  appointment: string;
}

const demoJourneySteps = [
  'Lead loaded',
  'Strategy ready',
  'Email sent',
  '48h no response',
  'AI call',
  'Appointment booked',
  'Business notified',
  'Prospect confirmed',
];

const demoLeads: DemoLead[] = [
  {
    company: 'Ready Roofing & Solar',
    industry: 'Roofing',
    city: 'Dallas, TX',
    decisionMaker: 'William Jeffery Thompson',
    contact: 'Verified email + phone · redacted in public demo',
    fitReason:
      'APEX identified a Dallas roofing contractor taking phone and free-inspection leads for high-ticket roof replacement and solar work. After-hours and storm-surge inquiries create a clear missed-opportunity window.',
    strategy:
      'Lead with the cost of missed inspection and storm-damage opportunities. Position an always-on AI front desk that responds immediately, qualifies roof or solar needs, books inspections, and preserves the account context for the sales team.',
    emailSubject: 'Capture the roofing leads that arrive when the office is closed',
    emailBody:
      'William — APEX identified a straightforward opportunity for Ready Roofing & Solar: high-value inspection and storm-damage inquiries do not always arrive during office hours. The system can answer those inquiries immediately, qualify the roof or solar need, book the next step, and keep the full conversation attached to the opportunity. I would start with a focused 30-day deployment around the Dallas market so the impact is measurable.',
    appointment: 'Tuesday · 10:30 AM',
  },
  {
    company: 'RESTOR Medical Spa',
    industry: 'MedSpa',
    city: 'Denver, CO',
    decisionMaker: 'Dr. Flora Waples, MD',
    contact: 'Verified email + phone · redacted in public demo',
    fitReason:
      'APEX identified a multi-location med spa taking phone and web appointment bookings with limited staffed hours, creating an after-hours window for injectable and consultation inquiries.',
    strategy:
      'Center the outreach on consultation capture across multiple locations. Show how voice and chat can answer common questions, qualify treatment interest, route by location, and book the consultation before the lead chooses another provider.',
    emailSubject: 'A 24/7 consultation layer for RESTOR’s locations',
    emailBody:
      'Dr. Waples — RESTOR already has the demand channels in place. The gap APEX identified is what happens when a consultation or injectable inquiry arrives after staffed hours. APEX can respond immediately, qualify the treatment interest and preferred location, answer common questions, and move the prospect into a booked consultation while preserving the full context for your team.',
    appointment: 'Thursday · 2:00 PM',
  },
  {
    company: 'Robins Plumbing Inc',
    industry: 'Plumbing',
    city: 'Phoenix, AZ',
    decisionMaker: 'Stephanie Robins',
    contact: 'Verified email + phone · redacted in public demo',
    fitReason:
      'APEX identified a full-service plumbing company handling round-the-clock demand. Routine calls, web inquiries, and emergency triage create a workload that can consume staff time and leak revenue when response capacity is constrained.',
    strategy:
      'Position APEX as a front-desk operating layer: handle routine questions, qualify the service need, triage emergencies, book service windows, and escalate only the conversations that require a person.',
    emailSubject: 'Take routine call load off the team without missing service revenue',
    emailBody:
      'Stephanie — APEX can sit in front of the routine call and web volume that reaches Robins Plumbing every day, handle the initial questions, qualify the service need, triage emergencies, and book the right service window. Your staff keeps control of the jobs that need a human while the system makes sure the rest of the pipeline does not go quiet.',
    appointment: 'Wednesday · 9:00 AM',
  },
];

export function PublicLanding({ onOperatorLogin }: PublicLandingProps) {
  const [selectedLeadIndex, setSelectedLeadIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [complete, setComplete] = useState(false);
  const selectedLead = demoLeads[selectedLeadIndex];

  useEffect(() => {
    if (!running) return;

    setComplete(false);
    setActiveStep(0);

    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      if (step >= demoJourneySteps.length) {
        window.clearInterval(timer);
        setRunning(false);
        setComplete(true);
        setActiveStep(demoJourneySteps.length - 1);
        return;
      }
      setActiveStep(step);
    }, 1650);

    return () => window.clearInterval(timer);
  }, [running]);

  const startDemo = () => {
    setComplete(false);
    setActiveStep(-1);
    setRunning(true);
  };

  const selectDemoLead = (index: number) => {
    if (running) return;
    setSelectedLeadIndex(index);
    setComplete(false);
    setActiveStep(-1);
  };

  const scrollToDemo = () => {
    document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const scrollToPilot = () => {
    document.getElementById('pilot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="public-shell">
      <header className="public-nav-wrap">
        <nav className="public-nav public-container" aria-label="APEX public navigation">
          <button className="public-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="public-brand-emblem" aria-hidden="true">ΛΛ</span>
            <span>
              <strong>APEX</strong>
              <small>Intelligence that executes.</small>
            </span>
          </button>

          <div className="public-nav-links">
            <button onClick={scrollToDemo}>How it works</button>
            <button onClick={scrollToPilot}>Pricing</button>
            <button className="public-nav-pilot" onClick={scrollToPilot}>Start pilot</button>
            <button className="public-login-link" onClick={onOperatorLogin}>
              <LockKeyhole size={14} />
              Operator login
            </button>
          </div>
        </nav>
      </header>

      <main>
        <section className="public-hero-cinematic">
          <div className="public-hero-backdrop" aria-hidden="true">
            <img src="/apex-branding.jpg" alt="" />
            <div className="public-hero-backdrop-shade" />
          </div>
          <div className="public-hero public-container">
          <div className="public-hero-copy">
            <div className="public-eyebrow">MANAGED PIPELINE · AUTONOMOUS AI WORKFORCE</div>
            <h1>
              Give APEX an objective.
              <span> Let the workforce go to work.</span>
            </h1>
            <p className="public-hero-lede">
              APEX researches the market, finds and qualifies the right prospects, creates individualized strategies,
              coordinates approved outreach, handles responses, maintains pipeline state and measures the path from
              opportunity to revenue.
            </p>

            <div className="public-hero-actions">
              <button className="btn-primary public-cta" onClick={scrollToPilot}>
                Start the 30-Day Pilot
                <ArrowRight size={16} />
              </button>
              <button className="btn-secondary public-cta" onClick={scrollToDemo}>
                See how it works
              </button>
            </div>

            <div className="public-hero-note">
              <strong>$1,750 one-time</strong>
              <span>30 days · real market · no annual contract</span>
            </div>

            <div className="public-trust-row">
              <span><ShieldCheck size={15} /> Human approval gates</span>
              <span><Network size={15} /> Coordinated agent workforce</span>
              <span><Gauge size={15} /> Outcome measurement</span>
            </div>
          </div>

          <div className="public-hero-brand-lockup" aria-label="APEX — Intelligence that executes">
            <img src="/apex-branding.jpg" alt="APEX — Intelligence that executes." />
          </div>
          </div>
        </section>

        <section className="public-proof-strip">
          <div className="public-container public-proof-grid">
            <div>
              <strong>Define</strong>
              <span>Your offer, market, economics and handoff rules</span>
            </div>
            <div>
              <strong>Deploy</strong>
              <span>Research, individualized strategy and controlled outreach</span>
            </div>
            <div>
              <strong>Advance</strong>
              <span>Responses, meetings, opportunities, revenue and cost</span>
            </div>
          </div>
        </section>

        <section className="public-section public-container" id="demo">
          <div className="public-section-heading public-journey-heading">
            <div className="public-eyebrow">LIVE SALES WORKFLOW SIMULATION</div>
            <h2>Watch one researched lead move from intelligence to a booked appointment.</h2>
            <p>
              These are APEX-researched account snapshots. Direct contact details are redacted. Outreach, responses,
              calls and appointments below are simulated in your browser so you can watch the operating model without
              sending a real message or placing a real call.
            </p>
          </div>

          <div className="public-demo-disclosure">
            <ShieldCheck size={16} />
            <span><strong>SIMULATION:</strong> real researched lead context, illustrative outreach and response path, zero external actions.</span>
          </div>

          <div className="public-lead-picker" role="group" aria-label="Choose an APEX-researched lead">
            {demoLeads.map((lead, index) => (
              <button
                key={lead.company}
                className={selectedLeadIndex === index ? 'active' : ''}
                onClick={() => selectDemoLead(index)}
                disabled={running}
              >
                <span>{lead.industry}</span>
                <strong>{lead.company}</strong>
                <small>{lead.city}</small>
              </button>
            ))}
          </div>

          <div className="public-journey-shell">
            <aside className="public-journey-intelligence">
              <div className="public-journey-panel-title">
                <span>01</span>
                <div>
                  <strong>Research snapshot</strong>
                  <small>Already sourced by APEX</small>
                </div>
              </div>

              <div className="public-lead-card">
                <div className="public-lead-company">
                  <div>
                    <span>{selectedLead.industry}</span>
                    <h3>{selectedLead.company}</h3>
                    <small>{selectedLead.city}</small>
                  </div>
                  <div className="public-qualified-chip">QUALIFIED</div>
                </div>

                <div className="public-lead-person">
                  <span>Decision maker</span>
                  <strong>{selectedLead.decisionMaker}</strong>
                  <small>{selectedLead.contact}</small>
                </div>

                <div className="public-lead-reason">
                  <span>WHY THIS ACCOUNT</span>
                  <p>{selectedLead.fitReason}</p>
                </div>
              </div>

              <div className={'public-strategy-card ' + (activeStep >= 1 || complete ? 'revealed' : '')}>
                <div className="public-card-label"><Sparkles size={14} /> UNIQUE SALES STRATEGY</div>
                <p>{selectedLead.strategy}</p>
                <div className="public-strategy-route">
                  <span>Email</span><i>→</i><span>48h</span><i>→</i><span>Voice</span><i>→</i><span>Qualify</span><i>→</i><span>Handoff</span>
                </div>
              </div>

              <button className="btn-primary public-journey-start" onClick={startDemo} disabled={running}>
                {running ? 'APEX is running the workflow…' : complete ? 'Run the simulation again' : 'Run the live simulation'}
                {!running && <ArrowRight size={16} />}
              </button>
            </aside>

            <div className="public-journey-execution">
              <div className="public-execution-topbar">
                <div>
                  <span className="public-terminal-dot" />
                  <span className="public-terminal-dot" />
                  <span className="public-terminal-dot" />
                </div>
                <strong>APEX · PROSPECT JOURNEY</strong>
                <span>{running ? 'RUNNING' : complete ? 'COMPLETE' : 'READY'}</span>
              </div>

              <div className="public-journey-progress" aria-label="Simulation progress">
                {demoJourneySteps.map((step, index) => (
                  <div
                    key={step}
                    className={
                      'public-progress-step ' +
                      (activeStep === index && running ? 'active ' : '') +
                      (complete || activeStep > index ? 'done' : '')
                    }
                  >
                    <span>{complete || activeStep > index ? <Check size={11} /> : index + 1}</span>
                    <small>{step}</small>
                  </div>
                ))}
              </div>

              <div className="public-execution-stage">
                <article className={'public-action-card public-email-action ' + (activeStep >= 2 || complete ? 'visible' : '')}>
                  <div className="public-action-head">
                    <div><Mail size={17} /><span>FIRST CONTACT · PERSONALIZED EMAIL</span></div>
                    <strong>{activeStep >= 2 || complete ? 'SENT' : 'QUEUED'}</strong>
                  </div>
                  <div className="public-email-meta">
                    <span>To</span><strong>{selectedLead.decisionMaker}</strong>
                    <span>Subject</span><strong>{selectedLead.emailSubject}</strong>
                  </div>
                  <p>{selectedLead.emailBody}</p>
                  <small>Generated from this prospect’s stored APEX research + individualized strategy.</small>
                </article>

                <div className={'public-time-jump ' + (activeStep >= 3 || complete ? 'visible' : '')}>
                  <Clock3 size={16} />
                  <div><strong>48 HOURS LATER</strong><span>No reply detected. Follow-up policy advances to voice.</span></div>
                </div>

                <article className={'public-action-card public-call-action ' + (activeStep >= 4 || complete ? 'visible' : '')}>
                  <div className="public-action-head">
                    <div><PhoneCall size={17} /><span>AUTOMATIC AI FOLLOW-UP CALL</span></div>
                    <strong>{activeStep >= 5 || complete ? 'QUALIFIED' : 'LIVE'}</strong>
                  </div>
                  <div className="public-call-wave" aria-hidden="true">
                    {Array.from({ length: 24 }).map((_, index) => <i key={index} />)}
                  </div>
                  <div className="public-call-transcript">
                    <p><strong>APEX:</strong> I’m following up on the note I sent about {selectedLead.company}. The reason I reached out was specific to the opportunity APEX identified in your current lead flow.</p>
                    <p><strong>SIMULATED PROSPECT:</strong> I saw it. Give me the short version.</p>
                    <p><strong>APEX:</strong> The system researches each account first, adapts the strategy, and then works email and voice until there is a qualified next step. Would a short walkthrough make sense?</p>
                    <p><strong>SIMULATED PROSPECT:</strong> Yes. Put something on my calendar.</p>
                  </div>
                </article>

                <article className={'public-appointment-card ' + (activeStep >= 5 || complete ? 'visible' : '')}>
                  <CalendarCheck size={22} />
                  <div>
                    <span>QUALIFIED APPOINTMENT</span>
                    <strong>{selectedLead.appointment}</strong>
                    <small>CRM stage updated automatically · research + transcript attached</small>
                  </div>
                </article>

                <div className="public-notification-grid">
                  <article className={'public-notification-card ' + (activeStep >= 6 || complete ? 'visible' : '')}>
                    <div className="public-card-label"><BellRing size={14} /> BUSINESS HANDOFF</div>
                    <h4>Your sales team is notified instantly.</h4>
                    <div><Mail size={14} /><span>Email: New qualified appointment + account brief</span></div>
                    <div><MessageSquareText size={14} /><span>SMS: {selectedLead.company} booked · {selectedLead.appointment}</span></div>
                  </article>

                  <article className={'public-notification-card ' + (activeStep >= 7 || complete ? 'visible' : '')}>
                    <div className="public-card-label"><Check size={14} /> PROSPECT CONFIRMATION</div>
                    <h4>The prospect gets the next step too.</h4>
                    <div><Mail size={14} /><span>Email: Calendar confirmation + meeting details</span></div>
                    <div><MessageSquareText size={14} /><span>SMS: Appointment confirmed · reply to reschedule</span></div>
                  </article>
                </div>

                {complete && (
                  <div className="public-demo-result public-journey-result">
                    <Check size={18} />
                    <div>
                      <strong>Pipeline outcome created.</strong>
                      <span>
                        Research → strategy → personalized email → timed follow-up call → qualification → appointment →
                        two-sided notification, with the CRM state carried through the entire journey.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-section-heading">
            <div className="public-eyebrow">WHAT APEX IS</div>
            <h2>AI that coordinates the work itself.</h2>
            <p>
              Most business software gives your team another interface to operate. APEX is designed to coordinate
              persistent work toward a defined objective, with human control where it matters.
            </p>
          </div>

          <div className="public-capability-grid">
            {[
              {
                icon: <Crosshair size={20} />,
                title: 'Market intelligence',
                body: 'Define the ICP, discover target accounts, identify decision-makers, enrich records and preserve account context.',
              },
              {
                icon: <Sparkles size={20} />,
                title: 'Individualized strategy',
                body: 'Create account-specific positioning and outreach angles instead of pushing one generic campaign to everyone.',
              },
              {
                icon: <MessageSquareText size={20} />,
                title: 'Multichannel execution',
                body: 'Coordinate approved email, SMS, voice, callbacks and follow-up as parts of one operating flow.',
              },
              {
                icon: <Bot size={20} />,
                title: 'Agent workforce',
                body: 'A hierarchical AI workforce delegates work across specialized executive, engineering and business roles.',
              },
              {
                icon: <ShieldCheck size={20} />,
                title: 'Human governance',
                body: 'High-impact actions remain gated by approvals, channel policy and configured operating boundaries.',
              },
              {
                icon: <BarChart3 size={20} />,
                title: 'Closed-loop measurement',
                body: 'Track outcomes from targeting through conversation, appointment, opportunity, customer and attributed revenue.',
              },
            ].map((item) => (
              <article className="public-capability-card glass-card" key={item.title}>
                <div className="public-capability-icon">{item.icon}</div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-section-heading">
            <div className="public-eyebrow">YOUR ROLE IS SIMPLE</div>
            <h2>You set the objective. APEX carries the workload.</h2>
            <p>
              APEX is built to remove the disconnected handoffs between research, sales activity and pipeline
              management. You stay in control of the objective and approvals; the workforce handles the operating loop.
            </p>
          </div>

          <div className="public-role-grid">
            {[
              ['01', 'Define the objective', 'Tell APEX what you sell, who you want, where to look, what matters and how a qualified opportunity should be handed off.'],
              ['02', 'Approve the boundaries', 'Review the market, messaging, channels, volume and governance rules before execution begins.'],
              ['03', 'Work the opportunities', 'APEX keeps the pipeline moving while you or your team handle the conversations that deserve a human.'],
            ].map(([number, title, body]) => (
              <article className="public-role-card glass-card" key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="public-section public-container" id="pilot">
          <div className="public-section-heading public-pricing-heading">
            <div className="public-eyebrow">APEX PRICING</div>
            <h2>Start with a real 30-day deployment. Scale when APEX proves the economics.</h2>
            <p>
              The pilot is intentionally priced far below a standard APEX deployment so you can put the workforce to
              work against your actual market before making a larger commitment.
            </p>
          </div>

          <div className="public-pricing-anchor">
            <div>
              <span>STANDARD DEPLOYMENT</span>
              <strong>From $4,500/month</strong>
            </div>
            <div className="public-pricing-anchor-arrow">→</div>
            <div className="public-pricing-anchor-pilot">
              <span>30-DAY PILOT</span>
              <strong>$1,750 one-time</strong>
              <small>Pilot payment credited toward your first full month when you continue.</small>
            </div>
          </div>

          <div className="public-pricing-grid">
            <article className="public-price-card public-price-card-featured">
              <div className="public-price-badge">BEST WAY TO START</div>
              <div className="public-price-kicker">30-DAY APEX PILOT</div>
              <h3>Put APEX to work before you commit.</h3>
              <div className="public-price">
                <strong>$1,750</strong>
                <span>one-time · 30 days</span>
              </div>
              <p>
                A managed deployment against a real market, with real prospect research, individualized strategy and
                controlled multichannel execution.
              </p>
              <a
                className="btn-primary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=Start%20an%20APEX%2030-Day%20Pilot"
              >
                Start a 30-Day Pilot
                <ArrowRight size={16} />
              </a>
              <div className="public-price-credit">
                Continue after the pilot and the full <strong>$1,750</strong> is credited toward your first month.
              </div>
              <div className="public-price-list">
                {[
                  'Up to 2,500 researched and qualified prospects',
                  'ICP, market targeting and campaign strategy',
                  'Decision-maker and contact research',
                  'Individualized strategy for each prospect',
                  'Automated email outreach and controlled follow-up',
                  'AI-powered outbound calling and inbound call handling',
                  'SMS follow-up where appropriate',
                  'CRM, pipeline tracking and appointment scheduling',
                  'Campaign performance reporting',
                  'Human approval controls and pilot review',
                  'No annual contract required for the pilot',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX GROWTH</div>
              <h3>Your ongoing autonomous sales operation.</h3>
              <div className="public-price">
                <strong>$4,500</strong>
                <span>per month</span>
              </div>
              <p>For businesses ready to make APEX part of their daily revenue operation.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Growth%20Deployment"
              >
                Deploy APEX Growth
              </a>
              <div className="public-price-list">
                {[
                  'Up to 5,000 new researched prospects/month',
                  'Continuous research and enrichment',
                  'Multiple active outreach campaigns',
                  'Personalized email, SMS, voice and follow-up',
                  'Inbound and outbound AI sales agents',
                  'CRM and pipeline management',
                  'Appointment scheduling and lead nurturing',
                  'Performance and revenue reporting',
                  'Managed onboarding and support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX SCALE</div>
              <h3>Run larger territories and more campaigns.</h3>
              <div className="public-price">
                <strong>$7,500</strong>
                <span>per month</span>
              </div>
              <p>For higher-volume sales operations, multiple markets or simultaneous campaign strategies.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Scale%20Deployment"
              >
                Talk About Scaling
              </a>
              <div className="public-price-list">
                {[
                  'Up to 15,000 new researched prospects/month',
                  'Multiple simultaneous markets or campaigns',
                  'Expanded outbound calling capacity',
                  'Advanced segmentation and sales personas',
                  'Higher-volume email and SMS orchestration',
                  'Multi-agent sales workflows',
                  'Advanced CRM automation and attribution',
                  'Priority optimization and support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX ENTERPRISE</div>
              <h3>Autonomous revenue infrastructure at scale.</h3>
              <div className="public-price">
                <strong>$12,500+</strong>
                <span>per month</span>
              </div>
              <p>For organizations that need custom volume, integrations, governance and dedicated deployment design.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Enterprise%20Deployment"
              >
                Build an Enterprise Deployment
              </a>
              <div className="public-price-list">
                {[
                  'High-volume prospect research',
                  'Custom account and prospect limits',
                  'Multiple business units, territories or brands',
                  'Custom AI workforce configuration',
                  'Dedicated voice and sales agents',
                  'Custom workflow, API and CRM integrations',
                  'Advanced governance and approval controls',
                  'Custom reporting and priority support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>
          </div>

          <div className="public-pricing-close">
            <div>
              <div className="public-eyebrow">WHY THE PILOT</div>
              <h3>You are not buying a demo. You are putting APEX to work.</h3>
            </div>
            <p>
              A standard APEX deployment begins at $4,500/month. The 30-day pilot lets you test the same operating
              model against your own market for $1,750, with no annual commitment—and that investment rolls into your
              first full month if you continue.
            </p>
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-fit-card glass-card">
            <div>
              <div className="public-eyebrow">BEST FIT</div>
              <h2>Where one qualified conversation has meaningful value.</h2>
            </div>
            <div className="public-fit-grid">
              <span><Users size={17} /> Owner-led and decision-maker-accessible businesses</span>
              <span><CircleDollarSign size={17} /> High-value services where one new customer matters</span>
              <span><Target size={17} /> Clear industry, geography or account universe</span>
              <span><Gauge size={17} /> Teams ready to handle additional opportunities now</span>
            </div>
          </div>
        </section>

        <section className="public-final-cta">
          <div className="public-container">
            <div className="public-eyebrow">TURN STRATEGY INTO EXECUTION</div>
            <h2>Intelligence that doesn’t just advise. It executes.</h2>
            <p>Start with a focused market, controlled execution and measurable pipeline outcomes.</p>
            <div className="public-final-actions">
              <a
                className="btn-primary public-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Pipeline%20Audit"
              >
                Start with the 30-Day Pilot
                <ArrowRight size={16} />
              </a>
              <button className="btn-secondary public-cta" onClick={onOperatorLogin}>
                <LockKeyhole size={15} />
                Existing operator login
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="public-footer public-container">
        <div className="public-brand">
          <span className="public-brand-mark" aria-hidden="true">A</span>
          <span><strong>APEX</strong><small>Autonomous AI Workforce</small></span>
        </div>
        <div>
          <span>apex.donmatthews.live</span>
          <span>don@donmatthews.live</span>
        </div>
      </footer>
    </div>
  );
}
