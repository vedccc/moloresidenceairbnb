import { apiFetch } from '@/lib/api-client';

export interface Me {
  id: string;
  username: string;
  display_name: string | null;
}

export interface MePatch {
  display_name?: string;
  password?: string;
}

export function fetchMe(): Promise<Me> {
  return apiFetch<Me>('/me');
}

export function updateMe(patch: MePatch): Promise<{ ok: boolean }> {
  return apiFetch('/me', { method: 'PATCH', body: JSON.stringify(patch) });
}
