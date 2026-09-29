-- Dial Room: live-call state shared across Vercel instances, and the call log.
create table if not exists public.dialroom_state (
  id text primary key,
  state jsonb not null,
  at timestamptz not null default now()
);
create table if not exists public.dialroom_calls (
  id text primary key,
  at timestamptz not null default now(),
  rec jsonb not null
);
create index if not exists dialroom_calls_at_idx on public.dialroom_calls (at desc);
-- Only the service-role key (server side) may touch these; no policies means no anon/authenticated access.
alter table public.dialroom_state enable row level security;
alter table public.dialroom_calls enable row level security;
