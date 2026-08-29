import type { DocumentClassification, IngestionStatus, RefusalReason, Role } from '@trialpulse/shared';

export const ROLE_LABELS: Record<Role, string> = {
  regulatory_affairs: 'Regulatory Affairs',
  clinical_operations: 'Clinical Operations',
  medical_affairs: 'Medical Affairs',
  site_monitor: 'Site Monitor',
  executive: 'Executive',
  it_admin: 'IT Administrator',
};

export const CLASSIFICATION_LABELS: Record<DocumentClassification, string> = {
  protocol: 'Protocols',
  investigator_brochure: 'Investigator Brochures',
  regulatory_submission: 'Regulatory Submissions',
  safety_report: 'Safety Reports',
  site_communication: 'Site Communications',
  competitive_intelligence: 'Competitive Intelligence',
};

export const INGESTION_STATUS_LABELS: Record<IngestionStatus, string> = {
  pending: 'Pending',
  indexed: 'Indexed',
  failed: 'Failed',
  outdated: 'Outdated',
};

export const REFUSAL_REASON_LABELS: Record<RefusalReason, string> = {
  no_relevant_chunks:
    "TrialPulse couldn't find information about this in the documents you're authorized to access.",
  no_authorized_documents:
    'There are no documents in your role’s access scope that address this question.',
  query_rejected:
    'This question could not be processed. Try rephrasing it as a direct question about a Meridian clinical document.',
};

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? role;
}

export function classificationLabel(classification: DocumentClassification): string {
  return CLASSIFICATION_LABELS[classification] ?? classification;
}
