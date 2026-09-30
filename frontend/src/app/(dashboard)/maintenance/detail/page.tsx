'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { Tables } from '@/backend/types';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { fetchMaintenanceTicket } from '@/lib/maintenance-api';
import { fetchProperties } from '@/lib/properties-api';
import { fetchUrgencyRules } from '@/lib/urgency-rules-api';
import { MaintenanceDetailClient } from '../maintenance-detail-client';

type Ticket = Tables<'maintenance_tickets'>;

function NotFound() {
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/maintenance" />}>
        <ArrowLeft data-icon="inline-start" />
        Back to Maintenance
      </Button>
      <h1 className="text-2xl font-semibold tracking-tight">Not Found</h1>
      <p className="text-muted-foreground">
        The ticket you are looking for does not exist or the ID is missing.
      </p>
    </div>
  );
}

function MaintenanceDetailContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';

  const {
    data: ticket,
    isLoading: ticketLoading,
    isError: ticketError,
  } = useQuery({
    queryKey: ['maintenance', id],
    queryFn: () => fetchMaintenanceTicket(id),
    enabled: !!id,
  });

  const { data: properties = [] } = useQuery({
    queryKey: ['properties'],
    queryFn: fetchProperties,
  });

  const { data: urgencyRules = [] } = useQuery({
    queryKey: ['urgency-rules'],
    queryFn: fetchUrgencyRules,
  });

  if (!id) {
    return <NotFound />;
  }

  if (ticketLoading) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/maintenance" />}>
          <ArrowLeft data-icon="inline-start" />
          Back to Maintenance
        </Button>
        <p className="text-sm text-muted-foreground">Loading ticket…</p>
      </div>
    );
  }

  if (ticketError || !ticket) {
    return <NotFound />;
  }

  const ticketRow = ticket as unknown as Ticket;

  const propertyName =
    properties.find((p) => p.id === ticketRow.property_id)?.name ?? 'Unknown';

  const urgencyRuleName = ticketRow.urgency_rule_id
    ? ((urgencyRules.find((r) => r.id === ticketRow.urgency_rule_id) as
        | { name?: string }
        | undefined)?.name ?? null)
    : null;

  return (
    <MaintenanceDetailClient
      ticket={ticketRow}
      propertyName={propertyName}
      urgencyRuleName={urgencyRuleName}
    />
  );
}

export default function MaintenanceDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            render={<Link href="/maintenance" />}
          >
            <ArrowLeft data-icon="inline-start" />
            Back to Maintenance
          </Button>
          <p className="text-sm text-muted-foreground">Loading ticket…</p>
        </div>
      }
    >
      <MaintenanceDetailContent />
    </Suspense>
  );
}
