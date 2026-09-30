'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RelativeTime } from '@/components/shared/relative-time';
import { Search, BookOpen } from 'lucide-react';

export interface KbListItem {
  id: string;
  name: string;
  content: string | null;
  updated_at: string | null;
  is_default_general: boolean;
  knowledge_base_rooms?: { room_number: string }[];
}

function contentPreview(content: string | null): string {
  if (!content) return 'No content';
  const trimmed = content.trim();
  return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 80) + '...';
}

export function KbListClient({
  knowledgeBases,
}: {
  knowledgeBases: KbListItem[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState('');

  const filtered = knowledgeBases.filter((kb) =>
    !search ? true : kb.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search knowledge bases..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="rounded-lg border mt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Assigned Rooms</TableHead>
              <TableHead>Content</TableHead>
              <TableHead className="text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length > 0 ? (
              filtered.map((kb) => {
                const roomCount = (kb.knowledge_base_rooms || []).length;
                return (
                  <TableRow
                    key={kb.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => router.push(`/knowledge-bases/detail?id=${kb.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="font-medium">{kb.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {roomCount === 0
                        ? 'None'
                        : `${roomCount} room${roomCount === 1 ? '' : 's'}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-md truncate">
                      {contentPreview(kb.content)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">
                      <RelativeTime date={kb.updated_at} />
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-center text-muted-foreground py-12"
                >
                  {search
                    ? 'No knowledge bases match your search.'
                    : 'No knowledge bases yet. Create one to get started.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
