'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchGdprCallers, eraseCallerData, type GdprCaller } from '@/lib/calls-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { ShieldOff, Trash2 } from 'lucide-react';

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Manual GDPR erasure.
 *
 * The agent already erases automatically when a caller asks on the phone, and
 * a call's transcript can be deleted on its own from the call detail page.
 * This covers the third case: someone writes in, or asks a member of staff, and
 * everything held about them has to go.
 *
 * Only callers who still have data are listed — once erased, a number
 * disappears from here, which is also the confirmation that it worked.
 */
export default function GdprPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['gdpr-callers'],
    queryFn: fetchGdprCallers,
  });

  const erase = useMutation({
    mutationFn: (phone: string) => eraseCallerData(phone),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['gdpr-callers'] });
      await queryClient.invalidateQueries({ queryKey: ['calls'] });
      await queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success(
        `Data erased from ${res.callsRedacted} ${res.callsRedacted === 1 ? 'call' : 'calls'}.`,
      );
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Could not erase the data.');
    },
  });

  const callers = (data ?? []).filter((c) =>
    filter.trim() === '' ? true : c.phone.includes(filter.trim()),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">GDPR</h1>
        <p className="mt-1 text-muted-foreground">
          Erase everything held about a caller, on request.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium">
              Callers with data on file
              {data && (
                <span className="ml-2 font-normal text-muted-foreground">{data.length}</span>
              )}
            </CardTitle>
            <Input
              placeholder="Search a number…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="max-w-56"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : callers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ShieldOff className="size-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {data && data.length === 0
                  ? 'No caller data on file.'
                  : 'No number matches that search.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {callers.map((c) => (
                <CallerRow
                  key={c.phone}
                  caller={c}
                  busy={erase.isPending}
                  onErase={() => erase.mutateAsync(c.phone)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Erasing removes the phone number and the transcript from every call that
        number made, and from any booking links. The calls themselves are kept
        without personal data, so your figures don&apos;t change. Numbers are also
        cleared automatically 14 days after a call, and immediately if a caller
        asks the agent on the phone.
      </p>
    </div>
  );
}

function CallerRow({
  caller,
  busy,
  onErase,
}: {
  caller: GdprCaller;
  busy: boolean;
  onErase: () => Promise<unknown>;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="font-mono text-sm">{caller.phone}</span>
      <span className="text-xs text-muted-foreground">
        {caller.calls} {caller.calls === 1 ? 'call' : 'calls'}
        {caller.transcripts > 0 && ` · ${caller.transcripts} with transcript`}
        {' · last '}
        {formatDate(caller.lastCall)}
      </span>
      <span className="ml-auto">
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm" disabled={busy}>
              <Trash2 data-icon="inline-start" />
              Delete all data
            </Button>
          }
          title="Erase all data for this caller?"
          description={
            <>
              This permanently removes the phone number{' '}
              <strong>{caller.phone}</strong> and{' '}
              <strong>
                {caller.transcripts} {caller.transcripts === 1 ? 'transcript' : 'transcripts'}
              </strong>{' '}
              across <strong>{caller.calls}</strong>{' '}
              {caller.calls === 1 ? 'call' : 'calls'}, plus any booking links sent
              to that number. It cannot be undone.
              <br />
              <br />
              The calls themselves are kept without personal data, so your call
              figures stay the same.
            </>
          }
          confirmLabel="Erase all data"
          onConfirm={async () => {
            await onErase();
          }}
        />
      </span>
    </li>
  );
}
