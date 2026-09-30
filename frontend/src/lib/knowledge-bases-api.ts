import { apiFetch } from '@/lib/api-client';

export interface KnowledgeBase {
  id: string;
  name: string;
  content: string;
  updated_at: string;
  is_default_general: boolean;
  knowledge_base_rooms?: { room_number: string }[];
}

export interface KbDetail {
  kb: Pick<KnowledgeBase, 'id' | 'name' | 'content' | 'is_default_general'> | null;
  properties: { id: string; name: string }[];
  propRooms: { property_id: string; room_number: string }[];
  allKbRooms: unknown[];
}

export function fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
  return apiFetch<KnowledgeBase[]>('/knowledge-bases');
}

export function fetchGeneralKb(): Promise<KnowledgeBase | null> {
  return apiFetch<KnowledgeBase | null>('/knowledge-bases/general');
}

export function fetchKbDetail(id: string): Promise<KbDetail> {
  return apiFetch<KbDetail>(`/knowledge-bases/${id}`);
}

export function createKnowledgeBase(
  name: string,
  opts?: { general?: boolean },
): Promise<{ ok: boolean; id: string }> {
  return apiFetch('/knowledge-bases', {
    method: 'POST',
    body: JSON.stringify({ name, general: opts?.general }),
  });
}

export function updateKb(
  id: string,
  patch: { name?: string; content?: string },
): Promise<{ ok: boolean }> {
  return apiFetch(`/knowledge-bases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function setKbGeneral(id: string, value: boolean): Promise<{ ok: boolean }> {
  return apiFetch(`/knowledge-bases/${id}/general`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

// A room assignment is property-scoped: the same room NUMBER exists at several
// properties, so we send { property_id, room_number } pairs.
export interface RoomRef {
  property_id: string;
  room_number: string;
}

export function saveKbRooms(id: string, rooms: RoomRef[]): Promise<{ ok: boolean }> {
  return apiFetch(`/knowledge-bases/${id}/rooms`, {
    method: 'PUT',
    body: JSON.stringify({ rooms }),
  });
}

export function removeKbRoom(
  id: string,
  roomNumber: string,
  otherKbId?: string,
  propertyId?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/knowledge-bases/${id}/rooms`, {
    method: 'DELETE',
    body: JSON.stringify({ roomNumber, otherKbId, property_id: propertyId }),
  });
}

export function deleteKb(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/knowledge-bases/${id}`, { method: 'DELETE' });
}
