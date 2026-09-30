'use client';

import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Tiny clipboard helper for UUIDs, phone numbers, reservation IDs. */
export function CopyButton({
  text,
  className,
  label,
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — silently ignore.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors',
        className
      )}
      aria-label={label ?? `Copy ${text}`}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-green-600" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {label && <span className="text-xs">{label}</span>}
    </button>
  );
}
