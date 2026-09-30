-- Same-night direct-booking sessions.
--
-- Created by the voice agent when a caller (after midnight) wants to stay the
-- current night. The `token` backs the public /book?token=... UI where the guest
-- picks a room + email, which triggers a direct KWHotel reservation.
--
-- RLS on with no policies: only the service role (edge fn `api` + the voice
-- agent) touches this table; the browser reaches it only through the edge fn.
--
-- NOTE: this file was authored while the Supabase DB was unreachable via MCP
-- (connection timeouts). Apply it once the DB is reachable:
--   supabase db push   (or run this SQL in the Supabase SQL editor)

create table if not exists public.same_night_bookings (
  id                     uuid primary key default gen_random_uuid(),
  token                  text unique not null,
  call_id                uuid,
  phone                  text,
  hotel_id               text,
  property_id            uuid,
  check_in               date not null,
  check_out              date not null,
  num_adults             int  not null default 1,
  num_children           int  not null default 0,
  status                 text not null default 'pending',   -- pending | selected | booked | expired
  selected_room_id       text,
  guest_email            text,
  kwhotel_reservation_id text,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz
);

alter table public.same_night_bookings enable row level security;

create index if not exists same_night_bookings_token_idx
  on public.same_night_bookings (token);
