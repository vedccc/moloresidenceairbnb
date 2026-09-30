'use client';

import { CopyButton } from './copy-button';

/** Pretty-printed, scrollable JSON block for tool_calls / debug payloads. */
export function JsonView({ data }: { data: unknown }) {
  const pretty = JSON.stringify(data, null, 2);

  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton text={pretty} />
      </div>
      <pre className="max-h-[600px] overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed font-mono">
        {pretty}
      </pre>
    </div>
  );
}
