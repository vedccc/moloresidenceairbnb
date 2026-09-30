'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RelativeTime } from '@/components/shared/relative-time';
import { PlusIcon, Sparkles } from 'lucide-react';
import {
  fetchKnowledgeBases,
  fetchGeneralKb,
  createKnowledgeBase,
} from '@/lib/knowledge-bases-api';
import { KbListClient, type KbListItem } from './kb-list-client';

export default function KnowledgeBasesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: knowledgeBases = [], isLoading } = useQuery({
    queryKey: ['kbs'],
    queryFn: fetchKnowledgeBases,
  });

  const { data: generalKb, isLoading: generalLoading } = useQuery({
    queryKey: ['kb-general'],
    queryFn: fetchGeneralKb,
  });

  const createGeneral = useMutation({
    mutationFn: () =>
      createKnowledgeBase('General Knowledge Base', { general: true }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['kb-general'] });
      queryClient.invalidateQueries({ queryKey: ['kbs'] });
      toast.success('General knowledge base created');
      router.push(`/knowledge-bases/detail?id=${res.id}`);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : 'Failed to create general knowledge base',
      );
    },
  });

  const generalId = generalKb?.id ?? null;
  const propertyKbs = (knowledgeBases as KbListItem[]).filter(
    (kb) => !kb.is_default_general && kb.id !== generalId,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge Bases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage content that the AI agent uses during calls.
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/knowledge-bases/new" />}>
          <PlusIcon data-icon="inline-start" />
          New Knowledge Base
        </Button>
      </div>

      {/* General Knowledge Base */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
              <h2 className="text-sm font-semibold tracking-tight">
                General Knowledge Base
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Loaded on every call — used when a caller isn&apos;t identified yet or
              asks a general question.
            </p>
            {!generalLoading && generalKb && (
              <p className="mt-2 text-sm">
                <span className="font-medium">{generalKb.name}</span>{' '}
                <span className="text-muted-foreground">
                  · updated <RelativeTime date={generalKb.updated_at} />
                </span>
              </p>
            )}
            {!generalLoading && !generalKb && (
              <p className="mt-2 text-sm text-muted-foreground">
                No general knowledge base set.
              </p>
            )}
          </div>

          <div className="shrink-0">
            {generalLoading ? null : generalKb ? (
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={
                  <Link href={`/knowledge-bases/detail?id=${generalKb.id}`} />
                }
              >
                Edit
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => createGeneral.mutate()}
                disabled={createGeneral.isPending}
              >
                {createGeneral.isPending
                  ? 'Creating…'
                  : 'Create general knowledge base'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Property & Room Knowledge Bases */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Property &amp; Room Knowledge Bases
        </h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading knowledge bases…</p>
        ) : (
          <KbListClient knowledgeBases={propertyKbs} />
        )}
      </div>
    </div>
  );
}
