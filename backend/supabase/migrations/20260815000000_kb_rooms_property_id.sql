-- Scope room→KB assignments to a property.
--
-- Room numbers repeat across properties (the "Rooms" properties all reuse
-- 1-7), and knowledge_base_rooms only stored `room_number` — so the same
-- number looked assigned to every property's KB at once. On a call that made
-- kb_for_room pull several properties' KBs (several Wi-Fi passwords) and the
-- matcher gave up; in the editor a room showed as selected under every property.
--
-- Fix: add property_id so "Boho / room 5" and "Riviera / room 5" are distinct
-- assignments, and enforce that a given (property, room) belongs to at most one
-- KB. Verified before writing this: all 87 current assignments are to property
-- KBs (0 without a KB property), and backfilling property from each KB yields 0
-- (property, room) duplicates — so the backfill + unique index apply cleanly and
-- destroy no data.

-- 1) Add the column (FK to properties; cascade so deleting a property clears its
--    room assignments).
alter table knowledge_base_rooms
  add column if not exists property_id uuid references properties(id) on delete cascade;

-- 2) Backfill property_id from each assignment's KB. Every current assignment is
--    to a property KB, so knowledge_bases.property_id is always present here.
update knowledge_base_rooms kbr
   set property_id = kb.property_id
  from knowledge_bases kb
 where kb.id = kbr.knowledge_base_id
   and kbr.property_id is null;

-- 3) Enforce one KB per (property, room). Verified: 0 conflicts in current data.
--    property_id is left NULLABLE on purpose: this avoids a hard cutover window
--    between running this migration and deploying the edge api that populates it
--    (an in-flight save would otherwise fail a NOT NULL check). Postgres treats
--    NULLs as distinct in a unique index, so the constraint bites for every real
--    (property, room) assignment; the edge api always sends property_id.
create unique index if not exists knowledge_base_rooms_property_room_uniq
  on knowledge_base_rooms (property_id, room_number);
