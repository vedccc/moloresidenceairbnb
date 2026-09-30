// Server-safe shared constants/types for urgency rules.
//
// These MUST live outside the 'use client' component: when a Server Component
// (page.tsx) imports a plain value from a 'use client' module, it receives a
// client-reference proxy instead of the real value — so `LEVELS.filter(...)`
// blew up with "LEVELS.filter is not a function". Importing from this neutral
// module gives both the server page and the client editor the real array.

export interface UrgencyRule {
  id: string;
  level: string;
  name: string;
  examples: string[];
  keywords: string[];
  sort_order: number;
}

export const LEVELS = [
  { level: 'critical', label: 'Critical', color: 'bg-red-100 text-red-800 border-red-200' },
  { level: 'high', label: 'High', color: 'bg-orange-100 text-orange-800 border-orange-200' },
  { level: 'medium', label: 'Medium', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
] as const;
