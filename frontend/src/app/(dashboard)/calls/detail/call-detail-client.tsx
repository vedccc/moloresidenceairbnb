'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Tables } from '@/backend/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { deleteCallTranscript } from '@/lib/calls-api';
import { formatEurFromUsd } from '@/lib/money';
import {
  callOutcomes,
  formatDuration,
  isEstimatedCost,
  type CallRow,
} from '@/lib/calls-view';
import { ArrowLeft, Trash2 } from 'lucide-react';

type CallLog = Tables<'call_logs'>;

/**
 * Labels for the cost components the agent records (call_cost.py). Spelled out
 * rather than run through humanize(), which would render the acronyms as "Tts"
 * and "Llm".
 */
const COST_COMPONENT_LABELS: Record<string, string> = {
  llm: 'LLM',
  stt: 'Speech-to-text',
  tts: 'Voice',
  session: 'LiveKit session',
  telephony: 'Telephony',
  kb_search: 'KB search',
};

/** Absolute date + time — staff want the wall-clock moment, not "2 hours ago". */
function formatStartedAt(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type Turn = { speaker: 'agent' | 'caller' | 'other'; text: string };

/**
 * The transcript is stored in `call_logs.summary` as raw newline-separated
 * "role: text" lines (see agent_pipeline.py — it is NOT a summary, despite the
 * column name). Parse those back into turns; anything that doesn't match the
 * pattern is passed through verbatim rather than dropped.
 */
function parseTranscript(raw: string | null | undefined): Turn[] {
  if (!raw?.trim()) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (!m) return { speaker: 'other' as const, text: line };
      const role = m[1].toLowerCase();
      if (role === 'assistant' || role === 'agent')
        return { speaker: 'agent' as const, text: m[2] };
      if (role === 'user' || role === 'caller')
        return { speaker: 'caller' as const, text: m[2] };
      return { speaker: 'other' as const, text: line };
    });
}

const SPEAKER_LABEL: Record<Turn['speaker'], string> = {
  agent: 'Mili',
  caller: 'Caller',
  other: '',
};

/**
 * Call detail — four facts and the transcript, nothing else.
 *
 * The Summary / Recording / Tool Calls / Raw JSON tabs were removed on request
 * (2026-08-15). Worth knowing before adding anything back:
 *   - Recording had nothing to show. The agent has no egress and never writes
 *     recording_url, so that tab always read "not available". Calls are not, and
 *     are not intended to be, recorded.
 *   - The old Transcript tab read call_logs.transcript_url, which nothing ever
 *     writes, so it always read "no transcript" — while the actual transcript sat
 *     in the Summary tab under a misleading name. This page reads the real one.
 */
export function CallDetail({ call }: { call: CallLog }) {
  const turns = parseTranscript(call.summary);
  const queryClient = useQueryClient();
  const outcomes = callOutcomes(call as unknown as CallRow);
  const costEstimated = isEstimatedCost(call as unknown as CallRow);
  const costParts = (call.cost_breakdown as { components_usd?: Record<string, number> } | null)
    ?.components_usd;

  const deleteTranscript = useMutation({
    mutationFn: () => deleteCallTranscript(call.id),
    onSuccess: async () => {
      // Refetch this call and the list — the list is what staff return to.
      await queryClient.invalidateQueries({ queryKey: ['calls'] });
      toast.success('Transcript deleted.');
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Could not delete the transcript.');
    },
  });

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/calls" />}>
        <ArrowLeft data-icon="inline-start" />
        Back to Calls
      </Button>

      <Card>
        <CardContent className="pt-6">
          <dl className="grid gap-6 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Started">{formatStartedAt(call.started_at)}</Field>
            <Field label="Duration">
              <span className="tabular-nums">
                {formatDuration(call.duration_seconds)}
              </span>
            </Field>
            <Field label="Caller">
              <span className="font-mono text-xs">{call.from_number ?? '—'}</span>
            </Field>
            <Field label={costEstimated ? 'Cost (estimated)' : 'Cost'}>
              <span className="tabular-nums">
                {call.cost_usd != null ? formatEurFromUsd(call.cost_usd) : '—'}
              </span>
              {/* Where the money went. Only a measured call has a real split
                  to show — an estimate is the same per-minute figure sliced up,
                  which would look like detail it hasn't got. */}
              {costParts && !costEstimated && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {Object.entries(costParts)
                    .filter(([, v]) => Number(v) > 0)
                    .sort(([, a], [, b]) => Number(b) - Number(a))
                    .map(
                      ([k, v]) =>
                        `${COST_COMPONENT_LABELS[k] ?? k} ${formatEurFromUsd(v)}`,
                    )
                    .join(' · ')}
                </p>
              )}
            </Field>
            {/* Outcomes, plural: what the call actually did, in rank order. */}
            <Field label={outcomes.length > 1 ? 'Outcomes' : 'Outcome'}>
              {outcomes.length === 0 ? (
                <StatusBadge kind="outcome" value={null} />
              ) : (
                <div className="flex flex-wrap gap-1">
                  {outcomes.map((o) => (
                    <StatusBadge key={o} kind="outcome" value={o} />
                  ))}
                </div>
              )}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium">Transcript</CardTitle>
            {turns.length > 0 && (
              <ConfirmDialog
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deleteTranscript.isPending}
                  >
                    <Trash2 data-icon="inline-start" />
                    {deleteTranscript.isPending ? 'Deleting…' : 'Delete transcript'}
                  </Button>
                }
                title="Delete this transcript?"
                description={
                  <>
                    This permanently removes all{' '}
                    <strong>{turns.length}</strong>{' '}
                    {turns.length === 1 ? 'line' : 'lines'} of conversation from
                    this call. It cannot be undone, and the agent keeps no other
                    copy.
                    <br />
                    <br />
                    The call record itself stays — start time, caller number,
                    duration and outcome are kept so your call metrics don&apos;t
                    change.
                  </>
                }
                confirmLabel="Delete transcript"
                onConfirm={async () => {
                  await deleteTranscript.mutateAsync();
                }}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {turns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No transcript recorded for this call.
            </p>
          ) : (
            <ol className="space-y-4">
              {turns.map((turn, i) => (
                <li key={i} className="space-y-1">
                  {SPEAKER_LABEL[turn.speaker] && (
                    <p
                      className={
                        turn.speaker === 'agent'
                          ? 'text-xs font-medium text-muted-foreground'
                          : 'text-xs font-medium text-foreground'
                      }
                    >
                      {SPEAKER_LABEL[turn.speaker]}
                    </p>
                  )}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {turn.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
