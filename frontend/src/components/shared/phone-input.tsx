'use client';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Loose E.164 check: optional +, 7–15 digits. Empty is treated as valid (optional field). */
export function isValidE164(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^\+?[1-9]\d{6,14}$/.test(trimmed.replace(/[\s-]/g, ''));
}

/** Normalize to E.164: strips spaces/dashes, defaults Poland (+48) when no country code. */
export function normalizeE164(value: string): string {
  const cleaned = value.trim().replace(/[\s-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return `+${cleaned.slice(2)}`;
  // Bare local number → assume Poland.
  return `+48${cleaned}`;
}

export function PhoneInput({
  value,
  onChange,
  onBlur,
  placeholder = '+48 123 456 789',
  className,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const invalid = value.trim() !== '' && !isValidE164(value);

  return (
    <Input
      id={id}
      type="tel"
      inputMode="tel"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      aria-invalid={invalid}
      className={cn(invalid && 'border-destructive', className)}
    />
  );
}
