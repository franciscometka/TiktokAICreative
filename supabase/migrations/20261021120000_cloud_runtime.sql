-- Lote 7 — Cloud Runtime (D101–D108). Fonte de verdade em Supabase Postgres.
-- Conceitos do domínio preservados: campanha e job continuam sendo documentos validados por Zod
-- (coluna `document`), com colunas indexadas para ownership, status e progresso.
-- Escrita só pelo backend (service role). RLS ligado: o browser nunca escreve direto.

-- gen_random_uuid() é nativo no Postgres 13+ (Supabase usa 15+): nenhuma extensão necessária.

-- ------------------------------------------------------------------ usuários
create table if not exists public.profiles (
  user_id uuid primary key,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ campanhas / projetos / jobs
create table if not exists public.campaigns (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  user_id uuid not null,
  status text not null check (status in ('draft', 'planning', 'planned', 'failed')),
  document jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists campaigns_user_created_idx on public.campaigns (user_id, created_at desc);

-- Projeto V2 = uma campanha (projeção para listagem barata por usuário).
create table if not exists public.projects (
  id text primary key references public.campaigns (id) on delete cascade,
  user_id uuid not null,
  title text not null default '',
  status text not null,
  ux_version int,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists projects_user_created_idx on public.projects (user_id, created_at desc);

create table if not exists public.jobs (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  user_id uuid not null,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  creative_id text not null,
  status text not null check (status in ('planned', 'cost_estimated', 'awaiting_approval', 'generating', 'budget_exceeded', 'audio_review', 'rendering', 'completed', 'failed', 'cancelled')),
  current_stage text,
  -- Progresso legível pelo frontend (polling): derivado do documento a cada gravação.
  progress_stage text not null default 'planning' check (progress_stage in ('planning', 'awaiting_approval', 'reference', 'awaiting_reference_approval', 'video_generation', 'rendering', 'uploading', 'completed', 'failed', 'blocked', 'cancelled')),
  document jsonb not null,
  revision bigint not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists jobs_user_status_idx on public.jobs (user_id, status);
create index if not exists jobs_campaign_idx on public.jobs (campaign_id);
create index if not exists jobs_status_idx on public.jobs (status);

-- ------------------------------------------------------------------ fila durável (D103)
create table if not exists public.job_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  job_id text references public.jobs (id) on delete cascade,
  kind text not null check (kind in ('planning', 'job_run')),
  payload jsonb not null,
  -- true = a tarefa pode fazer chamada paga: nunca é reexecutada sozinha se o retorno ficar incerto.
  paid boolean not null,
  dedupe_key text not null,
  status text not null check (status in ('queued', 'running', 'awaiting_approval', 'blocked', 'failed', 'completed')),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts between 1 and 10),
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  run_after timestamptz not null default now(),
  outcome text,
  last_error text,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
-- Clique duplo / spam: no máximo UMA tarefa ativa por chave (ex.: job:<id>).
create unique index if not exists job_queue_active_dedupe_idx on public.job_queue (dedupe_key) where status in ('queued', 'running');
-- Dois workers nunca rodam a MESMA campanha ao mesmo tempo.
create unique index if not exists job_queue_one_running_per_campaign_idx on public.job_queue (campaign_id) where status = 'running';
create index if not exists job_queue_claim_idx on public.job_queue (run_after, created_at) where status = 'queued';
create index if not exists job_queue_lease_idx on public.job_queue (lease_expires_at) where status = 'running';
create index if not exists job_queue_user_status_idx on public.job_queue (user_id, status);
create index if not exists job_queue_job_idx on public.job_queue (job_id, created_at desc);

-- ------------------------------------------------------------------ operações pagas (D104)
create table if not exists public.job_attempts (
  id text primary key,
  user_id uuid not null,
  job_id text not null references public.jobs (id) on delete cascade,
  campaign_id text not null,
  stage text not null,
  provider text,
  model text,
  status text not null check (status in ('started', 'submitted', 'confirmed', 'failed', 'uncertain')),
  paid boolean not null default true,
  external_ref text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists job_attempts_job_stage_idx on public.job_attempts (job_id, stage);

create table if not exists public.job_events (
  id bigserial primary key,
  user_id uuid not null,
  campaign_id text not null,
  job_id text,
  type text not null,
  stage text,
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists job_events_job_idx on public.job_events (job_id, id desc);
create index if not exists job_events_campaign_idx on public.job_events (campaign_id, id desc);

-- ------------------------------------------------------------------ ledger append-only (D105)
create table if not exists public.ledger_entries (
  id text primary key,
  user_id uuid not null,
  campaign_id text not null,
  job_id text,
  attempt_id text,
  llm_call_id text,
  stage text not null,
  operation text not null,
  provider text not null,
  model text not null,
  estimated_cost_brl numeric(14, 6),
  confirmed_cost_usd numeric(16, 8) not null check (confirmed_cost_usd >= 0),
  confirmed_cost_brl numeric(14, 6) not null check (confirmed_cost_brl >= 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  status text not null check (status in ('confirmed', 'simulated')),
  entry jsonb not null,
  created_at timestamptz not null
);
create index if not exists ledger_entries_campaign_idx on public.ledger_entries (campaign_id, created_at);
create index if not exists ledger_entries_job_idx on public.ledger_entries (job_id);
create index if not exists ledger_entries_user_idx on public.ledger_entries (user_id, created_at desc);

create or replace function public.ledger_entries_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries é append-only (% bloqueado)', tg_op using errcode = 'P0001';
end;
$$;
drop trigger if exists ledger_entries_no_update on public.ledger_entries;
create trigger ledger_entries_no_update before update or delete on public.ledger_entries
  for each row execute function public.ledger_entries_append_only();

create table if not exists public.llm_calls (
  id text primary key,
  user_id uuid not null,
  campaign_id text not null,
  record jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists llm_calls_campaign_idx on public.llm_calls (campaign_id);

-- ------------------------------------------------------------------ avatares / vozes
create table if not exists public.avatars (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  user_id uuid not null,
  current_revision int not null check (current_revision >= 1),
  archived boolean not null default false,
  current jsonb not null,
  updated_at timestamptz not null
);
create index if not exists avatars_user_updated_idx on public.avatars (user_id, updated_at desc);

-- Revisões congeladas: nunca atualizadas nem apagadas (jobs antigos dependem delas).
create table if not exists public.avatar_revisions (
  avatar_id text not null references public.avatars (id) on delete restrict,
  revision int not null check (revision >= 1),
  user_id uuid not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key (avatar_id, revision)
);

create table if not exists public.voice_profiles (
  id text not null,
  user_id uuid not null,
  position int not null default 0,
  profile jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ------------------------------------------------------------------ arquivos (D106)
create table if not exists public.product_assets (
  id text not null,
  user_id uuid not null,
  owner_id text not null,
  owner_kind text not null check (owner_kind in ('product', 'avatar')),
  bucket text not null,
  path text not null,
  local_uri text not null,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes > 0),
  status text not null check (status in ('pending', 'ready', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (bucket, path)
);
create index if not exists product_assets_user_owner_idx on public.product_assets (user_id, owner_id);

create table if not exists public.generated_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  kind text not null check (kind in ('reference', 'clip', 'audio', 'render')),
  bucket text not null,
  path text not null,
  local_uri text not null,
  content_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  created_at timestamptz not null default now(),
  unique (bucket, path),
  unique (campaign_id, local_uri)
);
create index if not exists generated_assets_campaign_idx on public.generated_assets (campaign_id, kind);
create index if not exists generated_assets_user_idx on public.generated_assets (user_id);

-- Projeções do documento do job (consulta/auditoria); o documento continua sendo a verdade.
create table if not exists public.ugc_references (
  id text primary key,
  user_id uuid not null,
  job_id text not null references public.jobs (id) on delete cascade,
  campaign_id text not null,
  version text,
  state text not null,
  approved boolean not null default false,
  local_uri text,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists ugc_references_job_idx on public.ugc_references (job_id);

create table if not exists public.render_jobs (
  id text primary key,
  user_id uuid not null,
  job_id text not null references public.jobs (id) on delete cascade,
  campaign_id text not null,
  render_id text not null,
  status text not null,
  output_local_uri text,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists render_jobs_job_idx on public.render_jobs (job_id);

create table if not exists public.change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  parsed jsonb not null,
  status text not null default 'estimated' check (status in ('estimated', 'confirmed', 'discarded')),
  created_at timestamptz not null default now()
);
create index if not exists change_requests_campaign_idx on public.change_requests (campaign_id, created_at desc);

-- ------------------------------------------------------------------ idempotência (D107)
create table if not exists public.idempotency_keys (
  user_id uuid not null,
  scope text not null,
  key text not null check (char_length(key) between 8 and 128),
  request_hash text not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, scope, key)
);
create index if not exists idempotency_keys_created_idx on public.idempotency_keys (created_at);

-- ------------------------------------------------------------------ RLS / Supabase
-- Só no Supabase (schema auth/storage presentes): FK para auth.users, RLS de leitura pelo dono e
-- bucket privado. Em Postgres puro (testes/PGlite) estes blocos são ignorados.
do $$
declare t text;
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    if not exists (select 1 from pg_constraint where conname = 'profiles_user_fk') then
      alter table public.profiles add constraint profiles_user_fk foreign key (user_id) references auth.users (id) on delete cascade;
    end if;
    foreach t in array array['profiles', 'campaigns', 'projects', 'jobs', 'job_queue', 'job_attempts', 'job_events', 'ledger_entries', 'llm_calls',
      'avatars', 'avatar_revisions', 'voice_profiles', 'product_assets', 'generated_assets', 'ugc_references', 'render_jobs', 'change_requests', 'idempotency_keys'] loop
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', t || '_owner_read', t);
      execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_owner_read', t);
    end loop;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tiktok-media', 'tiktok-media', false, 524288000,
      array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav', 'application/json'])
    on conflict (id) do nothing;
  end if;
end;
$$;
