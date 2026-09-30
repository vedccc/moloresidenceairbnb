'use client';

import { useEffect, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChipInput } from '@/components/shared/chip-input';
import {
  PhoneInput,
  isValidE164,
  normalizeE164,
} from '@/components/shared/phone-input';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import {
  ChevronDownIcon,
  XIcon,
  Trash2Icon,
  InfoIcon,
  DownloadIcon,
} from 'lucide-react';
import {
  updateProperty,
  deleteProperty,
  addRoom,
  removeRoom,
  type PropertyWithRooms,
  type PropertyInput,
} from '@/lib/properties-api';

export type { PropertyWithRooms };

const TIMEZONES = ['Europe/Warsaw', 'Europe/London', 'Europe/Berlin', 'UTC'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

export function PropertiesList({
  properties,
}: {
  properties: PropertyWithRooms[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {properties.map((property) => (
        <PropertyAccordionItem
          key={property.id}
          property={property}
          isExpanded={expandedId === property.id}
          onToggle={() =>
            setExpandedId((prev) => (prev === property.id ? null : property.id))
          }
        />
      ))}
    </div>
  );
}

function PropertyAccordionItem({
  property,
  isExpanded,
  onToggle,
}: {
  property: PropertyWithRooms;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(property.name);
  const [address, setAddress] = useState(property.address);
  const [kwHotelId, setKwHotelId] = useState(
    property.kwhotel_hotel_id?.toString() ?? ''
  );
  const [transferPhone, setTransferPhone] = useState(property.transfer_phone ?? '');
  const [aliases, setAliases] = useState<string[]>(property.aliases);
  const [language, setLanguage] = useState(property.language_default);
  const [timezone, setTimezone] = useState(property.timezone);
  const [notes, setNotes] = useState(property.notes ?? '');
  const [rooms, setRooms] = useState<string[]>(property.rooms);
  const [newRoom, setNewRoom] = useState('');
  const [addingRoom, setAddingRoom] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['properties'] });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProperty(id),
    onSuccess: invalidate,
  });

  useEffect(() => {
    setName(property.name);
    setAddress(property.address);
    setKwHotelId(property.kwhotel_hotel_id?.toString() ?? '');
    setTransferPhone(property.transfer_phone ?? '');
    setAliases(property.aliases);
    setLanguage(property.language_default);
    setTimezone(property.timezone);
    setNotes(property.notes ?? '');
    setRooms(property.rooms);
  }, [property]);

  async function savePatch(patch: Partial<PropertyInput>) {
    try {
      await updateProperty(property.id, patch);
      Object.assign(property, patch);
      invalidate();
    } catch (err) {
      toast.error(`Failed to save: ${errorMessage(err)}`);
    }
  }

  function debouncedNameAddress(newName: string, newAddress: string) {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      if (newName.trim() && newAddress.trim()) {
        savePatch({ name: newName.trim(), address: newAddress.trim() });
      }
    }, 800);
  }

  async function saveKwHotelId() {
    const trimmed = kwHotelId.trim();
    let value: number | null = null;
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        toast.error('KW Hotel ID must be a positive whole number.');
        setKwHotelId(property.kwhotel_hotel_id?.toString() ?? '');
        return;
      }
      value = parsed;
    }
    if (value === (property.kwhotel_hotel_id ?? null)) return;
    savePatch({ kwhotel_hotel_id: value });
  }

  async function handleAddRoom() {
    const roomNumber = newRoom.trim();
    if (!roomNumber) return;
    if (rooms.includes(roomNumber)) {
      toast.error('Room already exists.');
      return;
    }
    setAddingRoom(true);
    try {
      await addRoom(property.id, roomNumber);
      setRooms((prev) =>
        [...prev, roomNumber].sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true })
        )
      );
      setNewRoom('');
      invalidate();
    } catch (err) {
      toast.error(`Failed to add room: ${errorMessage(err)}`);
    } finally {
      setAddingRoom(false);
    }
  }

  async function handleRemoveRoom(roomNumber: string) {
    try {
      await removeRoom(property.id, roomNumber);
      setRooms((prev) => prev.filter((r) => r !== roomNumber));
      invalidate();
    } catch (err) {
      toast.error(`Failed to remove room: ${errorMessage(err)}`);
    }
  }

  return (
    <Card>
      <div className="flex w-full items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 flex-col text-left"
        >
          <span className="font-medium truncate">{property.name}</span>
          <span className="text-sm text-muted-foreground truncate">
            {property.address}
          </span>
        </button>
        <div className="flex items-center gap-3 shrink-0 ml-4">
          <Badge variant="outline" className="uppercase">
            {language === 'pl' ? 'PL' : 'EN'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {kwHotelId.trim() ? (
              `KW #${kwHotelId.trim()}`
            ) : (
              <span className="italic">No KW ID</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {rooms.length} {rooms.length === 1 ? 'room' : 'rooms'}
          </span>
          <button
            type="button"
            onClick={onToggle}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <ChevronDownIcon
              className={`size-4 text-muted-foreground transition-transform duration-200 ${
                isExpanded ? 'rotate-180' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {isExpanded && (
        <CardContent className="border-t pt-4 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Name
              </label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  debouncedNameAddress(e.target.value, address);
                }}
                placeholder="Property name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Address
              </label>
              <Input
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                  debouncedNameAddress(name, e.target.value);
                }}
                placeholder="Full address"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                KW Hotel ID
              </label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="What is the KW Hotel ID?"
                        className="text-muted-foreground hover:text-foreground"
                      />
                    }
                  >
                    <InfoIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>
                    The HotelId for this property in the KWHotel PMS. Optional.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={kwHotelId}
              onChange={(e) => setKwHotelId(e.target.value)}
              onBlur={saveKwHotelId}
              placeholder="e.g. 839"
              className="w-48"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Transfer phone
              </label>
              <PhoneInput
                value={transferPhone}
                onChange={setTransferPhone}
                onBlur={() => {
                  if (!isValidE164(transferPhone)) {
                    toast.error('Enter a valid phone number.');
                    setTransferPhone(property.transfer_phone ?? '');
                    return;
                  }
                  const normalized = transferPhone.trim()
                    ? normalizeE164(transferPhone)
                    : null;
                  if (normalized !== (property.transfer_phone ?? null)) {
                    savePatch({ transfer_phone: normalized });
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Default language
              </label>
              <div className="flex gap-2">
                {(['en', 'pl'] as const).map((lang) => (
                  <Button
                    key={lang}
                    type="button"
                    variant={language === lang ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setLanguage(lang);
                      savePatch({ language_default: lang });
                    }}
                  >
                    {lang === 'en' ? 'English' : 'Polski'}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => {
                setTimezone(e.target.value);
                savePatch({ timezone: e.target.value });
              }}
              className="flex h-9 w-64 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Aliases
            </label>
            <ChipInput
              value={aliases}
              onChange={(next) => {
                setAliases(next);
                savePatch({ aliases: next });
              }}
              placeholder="Alternative names guests use…"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Internal notes
            </label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                const value = notes.trim() || null;
                if (value !== (property.notes ?? null)) {
                  savePatch({ notes: value });
                }
              }}
              placeholder="Staff-only notes (never shown to the agent)…"
              rows={3}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Room Numbers
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                title="KWHotel import coming soon"
              >
                <DownloadIcon data-icon="inline-start" />
                Import from KWHotel
              </Button>
            </div>
            {rooms.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {rooms.map((room) => (
                  <Badge
                    key={room}
                    variant="secondary"
                    className="gap-1.5 pl-2.5 pr-1.5 py-1 h-auto text-sm"
                  >
                    {room}
                    <button
                      type="button"
                      onClick={() => handleRemoveRoom(room)}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-foreground/10 transition-colors"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No rooms assigned yet.
              </p>
            )}
            <div className="flex items-center gap-2">
              <Input
                value={newRoom}
                onChange={(e) => setNewRoom(e.target.value)}
                placeholder="Room number"
                className="w-36"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddRoom();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddRoom}
                disabled={addingRoom || !newRoom.trim()}
              >
                {addingRoom ? 'Adding...' : 'Add'}
              </Button>
            </div>
          </div>

          <div className="border-t pt-4">
            <ConfirmDialog
              trigger={
                <Button variant="destructive" size="sm" type="button">
                  <Trash2Icon data-icon="inline-start" />
                  Delete Property
                </Button>
              }
              title="Delete Property"
              description={
                <>
                  This permanently deletes &ldquo;{property.name}&rdquo; and all
                  its knowledge bases and room assignments. This cannot be undone.
                </>
              }
              confirmLabel="Delete"
              onConfirm={async () => {
                try {
                  await deleteMutation.mutateAsync(property.id);
                  toast.success('Property deleted');
                } catch (err) {
                  toast.error(`Failed to delete: ${errorMessage(err)}`);
                }
              }}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}
