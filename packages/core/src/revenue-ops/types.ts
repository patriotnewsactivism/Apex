// ─── Revenue Operations Types ───────────────────────────────────────────────────

export type OutboundChannel = 'phone' | 'sms' | 'email';

export type ComplianceDecisionType = 'allow' | 'deny' | 'require_approval';

export type ComplianceReasonCode =
  | 'SUPPRESSED'
  | 'OUTREACH_GATE_DENIED'
  | 'NO_CONSENT'
  | 'PURPOSE_MISMATCH'
  | 'JURISDICTION_RESTRICTED';

export interface ComplianceReason {
  code: ComplianceReasonCode;
  message: string;
}

export interface EvaluateOutboundActionInput {
  organizationId: string;
  contactId: string;
  channel: OutboundChannel;
  destination?: string;
  purpose?: string;
  campaignId?: string;
  scheduledTime?: Date;
  timezone?: string;
}

export interface ComplianceDecision {
  decision: ComplianceDecisionType;
  reasons: ComplianceReason[];
  evaluatedAt: Date;
  metadata?: {
    contactStatus?: string;
    consentStatus?: string;
    suppressionReason?: string;
    gateStatus?: string;
    timezoneUsed?: string;
  };
}
