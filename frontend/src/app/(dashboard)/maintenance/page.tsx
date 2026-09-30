'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMaintenance } from '@/lib/maintenance-api';
import { fetchProperties } from '@/lib/properties-api';
import { MaintenanceClient } from './maintenance-client';
import type { Tables } from '@/backend/types';

type Ticket = Tables<'maintenance_tickets'>;
type Property = Tables<'properties'>;

export default function MaintenancePage() {
  const { data: tickets = [], isLoading: ticketsLoading } = useQuery({
    queryKey: ['maintenance'],
    queryFn: fetchMaintenance,
  });
  const { data: properties = [], isLoading: propertiesLoading } = useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  });

  const roomsByProperty = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const p of properties) {
      map[p.id] = [...p.rooms].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      );
    }
    return map;
  }, [properties]);

  if (ticketsLoading || propertiesLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <p className="text-sm text-muted-foreground">Loading tickets…</p>
      </div>
    );
  }

  return (
    <MaintenanceClient
      tickets={tickets as unknown as Ticket[]}
      properties={properties as unknown as Property[]}
      roomsByProperty={roomsByProperty}
    />
  );
}
