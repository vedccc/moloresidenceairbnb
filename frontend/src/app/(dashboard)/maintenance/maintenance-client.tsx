'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Tables } from '@/backend/types';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/shared/status-badge';
import { RelativeTime } from '@/components/shared/relative-time';
import { PlusIcon, Wrench } from 'lucide-react';
import { createMaintenanceTicket } from '@/lib/maintenance-api';

type Ticket = Tables<'maintenance_tickets'>;
type Property = Tables<'properties'>;

const URGENCY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const URGENCY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'cancelled'] as const;

function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function MaintenanceClient({
  tickets,
  properties,
  roomsByProperty,
}: {
  tickets: Ticket[];
  properties: Property[];
  roomsByProperty: Record<string, string[]>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Filters
  const [statusFilter, setStatusFilter] = useState<Set<string>>(
    new Set(['open', 'in_progress'])
  );
  const [urgencyFilter, setUrgencyFilter] = useState<Set<string>>(new Set());
  const [propertyFilter, setPropertyFilter] = useState<string>('all');

  // New ticket dialog
  const [createOpen, setCreateOpen] = useState(false);

  const propertyName = (id: string) =>
    properties.find((p) => p.id === id)?.name ?? 'Unknown';

  function toggleSet(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    value: string
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const visible = tickets
    .filter((t) => {
      if (statusFilter.size > 0 && !statusFilter.has(t.status)) return false;
      if (urgencyFilter.size > 0 && !urgencyFilter.has(t.urgency)) return false;
      if (propertyFilter !== 'all' && t.property_id !== propertyFilter)
        return false;
      return true;
    })
    .sort((a, b) => {
      const ua = URGENCY_ORDER[a.urgency] ?? 99;
      const ub = URGENCY_ORDER[b.urgency] ?? 99;
      if (ua !== ub) return ua - ub;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  function truncate(text: string, n = 60): string {
    if (text.length <= n) return text;
    return text.slice(0, n) + '...';
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track and resolve maintenance tickets across all properties.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button />}>
            <PlusIcon data-icon="inline-start" />
            New Ticket
          </DialogTrigger>
          <NewTicketDialog
            properties={properties}
            roomsByProperty={roomsByProperty}
            onClose={() => setCreateOpen(false)}
            onCreated={() =>
              queryClient.invalidateQueries({ queryKey: ['maintenance'] })
            }
          />
        </Dialog>
      </div>

      {/* Filter bar */}
      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground w-16">
            Status
          </span>
          {STATUS_OPTIONS.map((s) => {
            const active = statusFilter.has(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSet(setStatusFilter, s)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  active ? 'ring-2 ring-ring/40' : 'opacity-50 hover:opacity-100'
                }`}
              >
                <StatusBadge kind="status" value={s} />
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground w-16">
            Urgency
          </span>
          {URGENCY_OPTIONS.map((u) => {
            const active = urgencyFilter.has(u);
            return (
              <button
                key={u}
                type="button"
                onClick={() => toggleSet(setUrgencyFilter, u)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  active ? 'ring-2 ring-ring/40' : 'opacity-50 hover:opacity-100'
                }`}
              >
                <StatusBadge kind="urgency" value={u} />
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground w-16">
            Property
          </span>
          <Select
            value={propertyFilter}
            onValueChange={(v) => setPropertyFilter((v as string) ?? 'all')}
          >
            <SelectTrigger className="w-64">
              <SelectValue placeholder="All properties" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All properties</SelectItem>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Property</TableHead>
              <TableHead>Room</TableHead>
              <TableHead>Urgency</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length > 0 ? (
              visible.map((t) => (
                <TableRow
                  key={t.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => router.push(`/maintenance/detail?id=${t.id}`)}
                >
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    <RelativeTime date={t.created_at} />
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">
                      {propertyName(t.property_id)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t.room_number}
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="urgency" value={t.urgency} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="status" value={t.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                    {truncate(t.description)}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {humanize(t.created_via)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-muted-foreground py-12"
                >
                  <div className="flex flex-col items-center gap-2">
                    <Wrench className="h-6 w-6 text-muted-foreground/50" />
                    <span>No tickets match the current filters.</span>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function NewTicketDialog({
  properties,
  roomsByProperty,
  onClose,
  onCreated,
}: {
  properties: Property[];
  roomsByProperty: Record<string, string[]>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [propertyId, setPropertyId] = useState('');
  const [roomNumber, setRoomNumber] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState<string>('medium');

  const createMutation = useMutation({
    mutationFn: createMaintenanceTicket,
  });
  const saving = createMutation.isPending;

  const rooms = propertyId ? roomsByProperty[propertyId] ?? [] : [];

  // Reset the selected room whenever the property changes.
  useEffect(() => {
    setRoomNumber('');
  }, [propertyId]);

  async function handleCreate() {
    if (!propertyId) {
      toast.error('Please select a property.');
      return;
    }
    if (!roomNumber.trim()) {
      toast.error('Please select or enter a room number.');
      return;
    }
    if (!description.trim()) {
      toast.error('Please enter a description.');
      return;
    }

    try {
      await createMutation.mutateAsync({
        property_id: propertyId,
        room_number: roomNumber.trim(),
        description: description.trim(),
        urgency,
      });
    } catch (err) {
      toast.error(
        `Failed to create ticket: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      return;
    }

    toast.success('Ticket created');
    onClose();
    setPropertyId('');
    setRoomNumber('');
    setDescription('');
    setUrgency('medium');
    onCreated();
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New Maintenance Ticket</DialogTitle>
        <DialogDescription>
          Create a ticket and assign it to a property and room.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Property</Label>
          <Select
            value={propertyId}
            onValueChange={(v) => setPropertyId((v as string) ?? '')}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a property" />
            </SelectTrigger>
            <SelectContent>
              {properties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Room</Label>
          <Select
            value={roomNumber}
            onValueChange={(v) => setRoomNumber((v as string) ?? '')}
            disabled={!propertyId || rooms.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  !propertyId
                    ? 'Select a property first'
                    : rooms.length === 0
                      ? 'No rooms for this property'
                      : 'Select a room'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {rooms.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the issue..."
            rows={4}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Urgency</Label>
          <Select
            value={urgency}
            onValueChange={(v) => setUrgency((v as string) ?? 'medium')}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select urgency" />
            </SelectTrigger>
            <SelectContent>
              {URGENCY_OPTIONS.map((u) => (
                <SelectItem key={u} value={u}>
                  {humanize(u)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleCreate} disabled={saving}>
          {saving ? 'Creating...' : 'Create Ticket'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
