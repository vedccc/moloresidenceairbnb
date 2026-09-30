'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Tables, TablesUpdate } from '@/backend/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatusBadge } from '@/components/shared/status-badge';
import { RelativeTime } from '@/components/shared/relative-time';
import { ArrowLeft, Phone, Building2 } from 'lucide-react';
import { updateMaintenanceTicket } from '@/lib/maintenance-api';

type Ticket = Tables<'maintenance_tickets'>;

const URGENCY_OPTIONS = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'cancelled'] as const;

function humanize(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function MaintenanceDetailClient({
  ticket,
  propertyName,
  urgencyRuleName,
}: {
  ticket: Ticket;
  propertyName: string;
  urgencyRuleName: string | null;
}) {
  const queryClient = useQueryClient();

  // Editable local state, seeded from the server-provided ticket.
  const [description, setDescription] = useState(ticket.description);
  const [reservationId, setReservationId] = useState(
    ticket.reservation_id ?? ''
  );
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  // Re-sync local fields whenever fresh server data arrives.
  useEffect(() => {
    setDescription(ticket.description);
    setReservationId(ticket.reservation_id ?? '');
  }, [ticket]);

  const updateMutation = useMutation({
    mutationFn: (patch: TablesUpdate<'maintenance_tickets'>) =>
      updateMaintenanceTicket(ticket.id, patch as Record<string, unknown>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      queryClient.invalidateQueries({ queryKey: ['maintenance', ticket.id] });
    },
  });

  // Generic update helper — patches the row then refreshes server data.
  async function patchTicket(
    patch: TablesUpdate<'maintenance_tickets'>,
    successMessage?: string
  ) {
    try {
      await updateMutation.mutateAsync(patch);
    } catch (err) {
      toast.error(
        `Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      return false;
    }
    if (successMessage) toast.success(successMessage);
    return true;
  }

  async function handleDescriptionBlur() {
    const trimmed = description.trim();
    if (!trimmed) {
      setDescription(ticket.description);
      return;
    }
    if (trimmed === ticket.description) return;
    await patchTicket({ description: trimmed }, 'Description saved');
  }

  async function handleReservationBlur() {
    const trimmed = reservationId.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === (ticket.reservation_id ?? null)) return;
    await patchTicket({ reservation_id: next }, 'Reservation ID saved');
  }

  async function handleUrgencyChange(value: string) {
    if (value === ticket.urgency) return;
    await patchTicket({ urgency: value }, 'Urgency updated');
  }

  async function handleStatusChange(value: string) {
    if (value === ticket.status) return;
    const patch: TablesUpdate<'maintenance_tickets'> = { status: value };
    if (value === 'resolved') {
      patch.resolved_at = new Date().toISOString();
    } else if (ticket.status === 'resolved') {
      // Un-resolving — clear the resolved timestamp.
      patch.resolved_at = null;
    }
    await patchTicket(patch, 'Status updated');
  }

  async function handleAddNote() {
    if (!newNote.trim()) return;
    setSavingNote(true);
    const stamp = new Date().toISOString();
    const entry = `[${stamp}] ${newNote.trim()}`;
    const nextNotes = ticket.notes ? `${ticket.notes}\n\n${entry}` : entry;
    const ok = await patchTicket({ notes: nextNotes }, 'Note added');
    if (ok) setNewNote('');
    setSavingNote(false);
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/maintenance" />}>
        <ArrowLeft data-icon="inline-start" />
        Back to Maintenance
      </Button>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          Ticket — {propertyName} · Room {ticket.room_number}
        </h1>
        <StatusBadge kind="status" value={ticket.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* LEFT — editable form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Property + room (read-only) */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Property</Label>
              <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium">{propertyName}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Room</Label>
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm font-medium">
                {ticket.room_number}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder="Describe the issue..."
              rows={5}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Urgency</Label>
              <Select
                value={ticket.urgency}
                onValueChange={(v) => handleUrgencyChange(v as string)}
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
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={ticket.status}
                onValueChange={(v) => handleStatusChange(v as string)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {humanize(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Reservation ID</Label>
            <Input
              value={reservationId}
              onChange={(e) => setReservationId(e.target.value)}
              onBlur={handleReservationBlur}
              placeholder="Optional reservation reference"
              className="max-w-sm"
            />
          </div>

          <Separator />

          {/* Notes (append-only) */}
          <div className="space-y-3">
            <Label>Notes</Label>
            {ticket.notes ? (
              <pre className="whitespace-pre-wrap rounded-lg border bg-muted/30 px-3 py-2 text-sm font-sans text-foreground/90">
                {ticket.notes}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No notes yet.</p>
            )}

            <div className="space-y-2">
              <Textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Add a note... (appended with a timestamp)"
                rows={3}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleAddNote}
                  disabled={savingNote || !newNote.trim()}
                >
                  {savingNote ? 'Adding...' : 'Add Note'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT — audit panel (read-only) */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Created</span>
                <RelativeTime
                  date={ticket.created_at}
                  className="text-foreground"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Resolved</span>
                <RelativeTime
                  date={ticket.resolved_at}
                  className="text-foreground"
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Source</span>
                <span className="text-foreground">
                  {humanize(ticket.created_via)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Urgency</span>
                <StatusBadge kind="urgency" value={ticket.urgency} />
              </div>

              <Separator />

              <div className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">Matched rule</span>
                <span className="text-foreground text-right">
                  {ticket.urgency_rule_id ? (
                    urgencyRuleName ?? 'Unknown rule'
                  ) : (
                    <span className="text-muted-foreground italic">None</span>
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Linked call</span>
                {ticket.call_id ? (
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false} render={<Link href={`/calls/detail?id=${ticket.call_id}`} />}
                  >
                    <Phone data-icon="inline-start" />
                    View call
                  </Button>
                ) : (
                  <span className="text-muted-foreground italic">None</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
