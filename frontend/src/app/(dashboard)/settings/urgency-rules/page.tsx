'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchUrgencyRules } from '@/lib/urgency-rules-api';
import { UrgencyRulesEditor } from './urgency-rules-client';
import { type UrgencyRule } from './levels';

export default function UrgencyRulesPage() {
  const { data: allRules = [], isLoading } = useQuery({
    queryKey: ['urgency-rules'],
    queryFn: fetchUrgencyRules,
  });

  const rulesMap: Record<string, UrgencyRule> = {};
  for (const rule of allRules) {
    rulesMap[rule.level] = {
      id: rule.id,
      level: rule.level,
      name: (rule.name as string) ?? '',
      examples: Array.isArray(rule.examples) ? (rule.examples as string[]) : [],
      keywords: Array.isArray(rule.keywords) ? (rule.keywords as string[]) : [],
      sort_order: (rule.sort_order as number) ?? 0,
    };
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Urgency Rules</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Define examples and descriptions for each urgency level. Changes are saved automatically.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading urgency rules…</p>
      ) : (
        <UrgencyRulesEditor rules={rulesMap} />
      )}
    </div>
  );
}
