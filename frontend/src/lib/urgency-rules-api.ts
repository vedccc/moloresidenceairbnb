import { apiFetch } from '@/lib/api-client';

export interface UrgencyRule {
  id: string;
  level: string;
  [key: string]: unknown;
}

export function fetchUrgencyRules(): Promise<UrgencyRule[]> {
  return apiFetch<UrgencyRule[]>('/urgency-rules');
}

export function saveUrgencyRules(rules: UrgencyRule[]): Promise<{ ok: boolean }> {
  return apiFetch('/urgency-rules', { method: 'PUT', body: JSON.stringify({ rules }) });
}
