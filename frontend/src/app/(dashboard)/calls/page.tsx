'use client';

import { useQuery } from '@tanstack/react-query';
import type { Tables } from '@/backend/types';
import { fetchCalls } from '@/lib/calls-api';
import { fetchProperties } from '@/lib/properties-api';
import { CallsList } from './calls-client';

type CallLog = Tables<'call_logs'>;
type Property = Pick<Tables<'properties'>, 'id' | 'name'>;

export default function CallsPage() {
  const { data: calls = [], isLoading: callsLoading } = useQuery({
    queryKey: ['calls'],
    queryFn: fetchCalls,
  });
  const { data: properties = [], isLoading: propertiesLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Calls</h1>
      {callsLoading || propertiesLoading ? (
        <p className="text-sm text-muted-foreground">Loading calls…</p>
      ) : (
        <CallsList
          calls={calls as unknown as CallLog[]}
          properties={properties as unknown as Property[]}
        />
      )}
    </div>
  );
}
