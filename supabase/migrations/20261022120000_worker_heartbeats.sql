-- L8.1 — presença do worker (status "online/offline" mesmo com a fila vazia).
-- Independente da fila: não toca job_queue, lease nem processamento. Uma linha por processo de
-- worker; `worker_key` é um hash opaco (nunca hostname, path, env ou segredo).
create table if not exists public.worker_heartbeats (
  worker_key text primary key check (worker_key ~ '^[a-f0-9]{16,64}$'),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null
);

create index if not exists worker_heartbeats_recent_idx on public.worker_heartbeats (heartbeat_at desc);

-- Só no Supabase: RLS ligada SEM policy — apenas o service role (API/worker) lê e escreve.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    alter table public.worker_heartbeats enable row level security;
  end if;
end;
$$;
