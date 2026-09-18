export type OutboundChannel = 'phone' | 'sms' | 'email';
export type ComplianceDecisionType = 'allow' | 'deny' | 'require_approval';

export type ComplianceReasonCode =
  | 'SUPPRESSED_CHANNEL'
  | 'SUPPRESSED_GLOBAL'
  | 'CONTACT_NOT_ACTIVE'
  | 'OUTSIDE_CALLING_WINDOW'
  | 'CONSENT_DENIED'
  | 'CONSENT_REVOKED'
  | 'CADENCE_EXCEEDED'
  | 'INVALID_DESTINATION';

export interface ComplianceReason {
  code: ComplianceReasonCode;
  message: string;
}

export interface OutboundActionRequest {
  organizationId: string;
  contactId: string;
  channel: OutboundChannel;
  destination: string;
  scheduledTime?: Date;
  purpose?: string;
  campaignId?: string;
  timezone?: string;
}

export interface ComplianceDecision {
  decision: ComplianceDecisionType;
  reasons: ComplianceReason[];
  evaluatedAt: Date;
  metadata?: {
    recipientLocalHour?: number;
    timezoneUsed?: string;
    suppressionId?: string;
    interactionCount24h?: number;
  };
}
