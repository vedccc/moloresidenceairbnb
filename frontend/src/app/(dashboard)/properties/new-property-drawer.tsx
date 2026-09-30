'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ChipInput } from '@/components/shared/chip-input';
import {
  PhoneInput,
  isValidE164,
  normalizeE164,
} from '@/components/shared/phone-input';
import { PlusIcon, XIcon } from 'lucide-react';
import { createProperty, addRoom } from '@/lib/properties-api';

const TIMEZONES = ['Europe/Warsaw', 'Europe/London', 'Europe/Berlin', 'UTC'];

export function NewPropertyDrawer() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [kwHotelId, setKwHotelId] = useState('');
  const [transferPhone, setTransferPhone] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [language, setLanguage] = useState<'en' | 'pl'>('en');
  const [timezone, setTimezone] = useState('Europe/Warsaw');
  const [notes, setNotes] = useState('');
  const [rooms, setRooms] = useState<string[]>([]);
  const [newRoom, setNewRoom] = useState('');

  const createMutation = useMutation({
    mutationFn: async (input: {
      name: string;
      address: string;
      kwhotel_hotel_id: number | null;
      transfer_phone: string | null;
      aliases: string[];
      language_default: string;
      timezone: string;
      notes: string | null;
      rooms: string[];
    }) => {
      const { rooms: stagedRooms, ...propertyInput } = input;
      const res = await createProperty(propertyInput);
      if (res.id && stagedRooms.length > 0) {
        await Promise.all(stagedRooms.map((r) => addRoom(res.id!, r)));
      }
      return res;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['properties'] }),
  });

  const submitting = createMutation.isPending;

  function reset() {
    setName('');
    setAddress('');
    setKwHotelId('');
    setTransferPhone('');
    setAliases([]);
    setLanguage('en');
    setTimezone('Europe/Warsaw');
    setNotes('');
    setRooms([]);
    setNewRoom('');
  }

  function addStagedRoom() {
    const r = newRoom.trim();
    if (!r) return;
    if (rooms.includes(r)) {
      toast.error('Room already added.');
      return;
    }
    setRooms((prev) =>
      [...prev, r].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    );
    setNewRoom('');
  }

  async function handleCreate() {
    if (!name.trim() || !address.trim()) {
      toast.error('Name and address are required.');
      return;
    }
    let kwhotelValue: number | null = null;
    const trimmedKw = kwHotelId.trim();
    if (trimmedKw) {
      const parsed = Number(trimmedKw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        toast.error('KW Hotel ID must be a positive whole number.');
        return;
      }
      kwhotelValue = parsed;
    }
    if (!isValidE164(transferPhone)) {
      toast.error('Transfer phone must be a valid phone number.');
      return;
    }

    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        address: address.trim(),
        kwhotel_hotel_id: kwhotelValue,
        transfer_phone: transferPhone.trim() ? normalizeE164(transferPhone) : null,
        aliases,
        language_default: language,
        timezone,
        notes: notes.trim() || null,
        rooms,
      });
    } catch (err) {
      toast.error(
        `Failed to create property: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
      return;
    }
    toast.success('Property created');
    reset();
    setOpen(false);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        New Property
      </SheetTrigger>
      <SheetContent side="left" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>New property</SheetTitle>
          <SheetDescription>Create a new property and its rooms.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="np-name">Name</Label>
            <Input
              id="np-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Property name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="np-address">Address</Label>
            <Input
              id="np-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Full address"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="np-kw">KW Hotel ID</Label>
            <Input
              id="np-kw"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={kwHotelId}
              onChange={(e) => setKwHotelId(e.target.value)}
              placeholder="e.g. 839"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="np-phone">Transfer phone</Label>
            <PhoneInput
              id="np-phone"
              value={transferPhone}
              onChange={setTransferPhone}
              placeholder="+48 123 456 789"
            />
          </div>

          <div className="space-y-2">
            <Label>Aliases</Label>
            <ChipInput
              value={aliases}
              onChange={setAliases}
              placeholder="Alternative names guests use…"
            />
          </div>

          <div className="space-y-2">
            <Label>Default language</Label>
            <div className="flex gap-2">
              {(['en', 'pl'] as const).map((lang) => (
                <Button
                  key={lang}
                  type="button"
                  variant={language === lang ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setLanguage(lang)}
                >
                  {lang === 'en' ? 'English' : 'Polski'}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="np-tz">Timezone</Label>
            <select
              id="np-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="np-notes">Internal notes</Label>
            <Textarea
              id="np-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Staff-only notes (never shown to the agent)…"
              rows={3}
            />
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label>Rooms</Label>
            {rooms.length > 0 && (
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
                      onClick={() =>
                        setRooms((prev) => prev.filter((r) => r !== room))
                      }
                      className="ml-0.5 rounded-full p-0.5 hover:bg-foreground/10 transition-colors"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
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
                    addStagedRoom();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addStagedRoom}
                disabled={!newRoom.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        </div>

        <SheetFooter className="border-t">
          <Button onClick={handleCreate} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create property'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
