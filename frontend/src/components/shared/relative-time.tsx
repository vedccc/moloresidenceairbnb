'use client';

import { formatDistanceToNow, format } from 'date-fns';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * "3 days ago" with the absolute timestamp on hover.
 * Accepts an ISO string, a Date, or null/undefined (renders an em dash).
 */
export function RelativeTime({
  date,
  className,
}: {
  date: string | Date | null | undefined;
  className?: string;
}) {
  if (!date) {
    return <span className={className}>—</span>;
  }

  const d = typeof date === 'string' ? new Date(date) : date;

  if (Number.isNaN(d.getTime())) {
    return <span className={className}>—</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className={className} />}>
          {formatDistanceToNow(d, { addSuffix: true })}
        </TooltipTrigger>
        <TooltipContent>{format(d, 'PPpp')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
