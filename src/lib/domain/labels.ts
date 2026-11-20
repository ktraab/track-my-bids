import type { AgencyType, Method, MilestoneType, ShipMethod } from './types';

export const AGENCY_TYPE_LABELS: Record<AgencyType, string> = {
  k12: 'K-12',
  higher_ed: 'Higher Ed',
  city: 'City',
  county: 'County',
  state: 'State',
  federal: 'Federal',
  other: 'Other',
};

export const METHOD_LABELS: Record<Method, string> = {
  online: 'Online',
  sealed: 'Sealed',
  email: 'Email',
};

export const SHIP_METHOD_LABELS: Record<ShipMethod, string> = {
  fedex: 'FedEx',
  ups: 'UPS',
  usps: 'USPS',
  courier: 'Courier',
  hand_delivery: 'Hand delivery',
};

export const MILESTONE_TYPE_LABELS: Record<MilestoneType, string> = {
  due: 'Due date',
  pre_bid: 'Pre-bid meeting',
  site_walk: 'Site walk',
  qa_deadline: 'Q&A deadline',
  addenda: 'Addenda expected',
  award: 'Award',
  allowable_contract: 'Allowable contract date',
  custom: 'Custom',
};

export function milestoneTitle(m: { type: MilestoneType; label: string | null }): string {
  return m.type === 'custom' ? (m.label ?? 'Custom') : MILESTONE_TYPE_LABELS[m.type];
}

export const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export function timezoneOptions(systemTz: string): string[] {
  return US_TIMEZONES.includes(systemTz) ? US_TIMEZONES : [systemTz, ...US_TIMEZONES];
}
