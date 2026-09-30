import { apiFetch } from '@/lib/api-client';

export interface CallLog {
  id: string;
  [key: string]: unknown;
}

export interface CallTicket {
  id: string;
  room_number?: string | null;
  status?: string;
  urgency?: string;
}

export interface CallBooking {
  id: string;
  guest_name?: string | null;
  converted?: boolean;
}

export interface CallDetail {
  call: CallLog;
  propertyName: string | null;
  costRates: Record<string, unknown> | null;
  tickets: CallTicket[];
  bookings: CallBooking[];
}

export function fetchCalls(): Promise<CallLog[]> {
  return apiFetch<CallLog[]>('/calls');
}

export function fetchCall(id: string): Promise<CallDetail> {
  return apiFetch<CallDetail>(`/calls/${id}`);
}

/**
 * Delete a call's transcript. The call itself (time, caller, duration, outcome)
 * is kept — only the conversation text is removed.
 */
export function deleteCallTranscript(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/calls/${id}/transcript`, { method: 'DELETE' });
}

export interface GdprCaller {
  phone: string;
  /** How many calls this number has on file. */
  calls: number;
  /** How many of those still hold a transcript. */
  transcripts: number;
  lastCall: string;
}

/** Callers who still have personal data on file. */
export function fetchGdprCallers(): Promise<GdprCaller[]> {
  return apiFetch<GdprCaller[]>('/calls/gdpr/callers');
}

/**
 * Erase everything held about one caller: phone number and transcript on every
 * call they made, plus their booking links. The call rows themselves are kept
 * so the dashboard's stats are unaffected.
 */
export function eraseCallerData(phone: string): Promise<{ ok: boolean; callsRedacted: number }> {
  return apiFetch('/calls/gdpr/erase', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  });
}
