import { apiFetch } from '@/lib/api-client';

export interface PropertyWithRooms {
  id: string;
  name: string;
  address: string;
  kwhotel_hotel_id: number | null;
  transfer_phone: string | null;
  aliases: string[];
  language_default: string;
  timezone: string;
  notes: string | null;
  rooms: string[];
}

export interface PropertyInput {
  name: string;
  address: string;
  kwhotel_hotel_id: number | null;
  transfer_phone: string | null;
  aliases: string[];
  language_default: string;
  timezone: string;
  notes: string | null;
}

export function fetchProperties(): Promise<PropertyWithRooms[]> {
  return apiFetch<PropertyWithRooms[]>('/properties');
}
export function createProperty(input: PropertyInput): Promise<{ ok: boolean; id?: string }> {
  return apiFetch('/properties', { method: 'POST', body: JSON.stringify(input) });
}
export function updateProperty(id: string, patch: Partial<PropertyInput>): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export function deleteProperty(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}`, { method: 'DELETE' });
}
export function addRoom(id: string, room_number: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}/rooms`, { method: 'POST', body: JSON.stringify({ room_number }) });
}
export function removeRoom(id: string, room_number: string): Promise<{ ok: boolean }> {
  return apiFetch(`/properties/${id}/rooms`, { method: 'DELETE', body: JSON.stringify({ room_number }) });
}
