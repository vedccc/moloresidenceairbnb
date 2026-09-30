'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { RefreshCwIcon } from 'lucide-react';

export function RefreshButton({ onClick }: { onClick?: () => void }) {
  const router = useRouter();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => (onClick ? onClick() : router.refresh())}
    >
      <RefreshCwIcon data-icon="inline-start" />
      Refresh
    </Button>
  );
}
