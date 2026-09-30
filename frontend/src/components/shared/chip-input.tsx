'use client';

import { useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { XIcon } from 'lucide-react';

/**
 * Comma/Enter to add, Backspace (on empty input) to remove the last chip.
 * Used for aliases, room numbers, urgency examples, and keywords.
 */
export function ChipInput({
  value,
  onChange,
  placeholder = 'Type and press Enter',
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState('');

  function addChip(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addChip(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function removeChip(chip: string) {
    onChange(value.filter((c) => c !== chip));
  }

  return (
    <div className={className}>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((chip) => (
            <Badge
              key={chip}
              variant="secondary"
              className="gap-1 pl-2.5 pr-1.5 py-1 h-auto text-sm"
            >
              {chip}
              <button
                type="button"
                onClick={() => removeChip(chip)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-foreground/10 transition-colors"
                aria-label={`Remove ${chip}`}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addChip(draft)}
        placeholder={placeholder}
      />
    </div>
  );
}
