'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createKnowledgeBase } from '@/lib/knowledge-bases-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function NewKnowledgeBasePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }

    setCreating(true);

    try {
      const res = await createKnowledgeBase(name);
      toast.success('Knowledge base created');
      router.push(`/knowledge-bases/detail?id=${res.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create knowledge base');
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/knowledge-bases" />}>
          <ArrowLeft />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New Knowledge Base</h1>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            placeholder="e.g. Check-in Instructions, Pool Rules..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
            }}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            You can assign properties and rooms in the editor.
          </p>
        </div>

        <Button onClick={handleCreate} disabled={creating || !name.trim()}>
          {creating ? 'Creating...' : 'Create Knowledge Base'}
        </Button>
      </div>
    </div>
  );
}
