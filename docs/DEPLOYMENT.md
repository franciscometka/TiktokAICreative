# Deploy (Lote 7): Supabase + Render + Vercel

Arquitetura e regras: `docs/CLOUD-RUNTIME.md`. Nenhum passo abaixo foi executado automaticamente. São passos manuais, na ordem.

## 0. Pré-requisitos
- Contas: Supabase, Render e Vercel.
- O repositório no GitHub (o Render e a Vercel fazem deploy a partir dele).
- Nunca commitar `.env*`. Todos os segredos vão no painel de cada serviço.

## 1. Supabase

1. Crie um projeto. Anote:
   - **Project URL**, que vira `SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_URL`;
   - **anon/publishable key**, que vira `NEXT_PUBLIC_SUPABASE_ANON_KEY` (pública);
   - **service_role/secret key**, que vira `SUPABASE_SERVICE_ROLE_KEY` (SÓ no Render).
2. **Database → Connection string:** use o pooler em modo **Session** (porta 5432), não Transaction, para que advisory locks e transações fiquem na mesma conexão. Esse valor vira `DATABASE_URL`.
3. **Migrations.** Escolha uma opção:
   - local: `DATABASE_URL=... npm run db:migrate`;
   - Supabase CLI: `supabase link` e depois `supabase db push`.

   A migration cria as tabelas, os índices, o RLS e o bucket privado `tiktok-media`.
4. **Auth:**
   - Habilite Email/Password.
   - Desative "Allow new users to sign up" (o acesso é só por convite).
   - Crie seu usuário em Authentication → Users.
5. **Storage:** confira que o bucket `tiktok-media` existe e é **privado**.

## 2. Render Web Service (API)

Crie **New → Web Service** a partir do repositório (ou use o Blueprint `render.yaml`):

| Campo | Valor |
|---|---|
| Runtime | Docker (`./Dockerfile`) |
| Start command | `npm run start:api` |
| Health check path | `/health` |
| Instance | Starter já serve (a API não renderiza) |

Variáveis de ambiente (backend):

| Variável | Valor |
|---|---|
| `PERSISTENCE_DRIVER` | `supabase` |
| `ASSET_STORE` | `supabase` |
| `DATABASE_URL` | pooler Session (segredo) |
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | segredo |
| `SUPABASE_STORAGE_BUCKET` | `tiktok-media` |
| `CORS_ALLOWED_ORIGINS` | `https://<seu-app>.vercel.app` (nunca `*`) |
| `LLM_PROVIDER`, `ANTHROPIC_API_KEY` | `anthropic`, segredo |
| `UGC_PROVIDER`, `UGC_REAL_ALLOWED`, `KREA_API_KEY` | `krea`, `true` só quando for validar REAL, segredo |
| `AUDIO_PROVIDER`, `ELEVENLABS_API_KEY` | conforme uso |
| `RENDERER` | `remotion` |
| `ALLOW_MOCKS` | `false` |
| `SIGNED_URL_TTL_SECONDS` | `600` (opcional) |

A API também precisa das variáveis de provider. Ela não chama os providers, mas calcula disponibilidade e cotação com elas. A configuração é validada na subida: variável ausente ou inválida derruba o deploy com o NOME da variável, nunca o valor.

Depois do deploy, confira:
- `GET https://<api>.onrender.com/health` responde `ok`;
- `GET /ready` traz `checks.database`, `checks.storage` e `checks.config` todos `true` (não chama API paga).

## 3. Render Background Worker

Crie **New → Background Worker** com o mesmo repositório e a mesma imagem:

| Campo | Valor |
|---|---|
| Runtime | Docker (`./Dockerfile`) |
| Start command | `npm run worker` |
| Instance | com RAM para Chrome e Remotion (recomendado ≥ 2 GB) |

- Variáveis: as mesmas do backend (exceto `CORS_*`/`PORT`), mais:
  - `WORKER_TMP_ROOT=/tmp/tiktok-ai`;
  - `WORKER_LEASE_SECONDS=120`;
  - `RUNWAYML_API_SECRET`, se usar.
- Mantenha sempre a **mesma versão** de código na API e no worker (deploy dos dois juntos).
- Diagnóstico sem custo: rode `npm run worker:check` num Shell do Render. Ele confere banco, storage, Chrome do Remotion e FFmpeg.
- O Render não tem healthcheck HTTP para background worker. O worker escreve "worker vivo" no log a cada minuto, com a contagem da fila.

Escala: uma tarefa por processo. Para paralelizar, aumente as instâncias do worker. O claim é exclusivo e cada campanha roda em série.

## 4. Vercel (frontend)

Importe o repositório como projeto Next.js.

| Campo | Valor |
|---|---|
| Root directory | `/` |
| Build command | `npm run build` (padrão) |
| Install command | `npm ci` (padrão) |

Variáveis (SÓ públicas):

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_RUNTIME_MODE` | `cloud` |
| `NEXT_PUBLIC_API_BASE_URL` | `https://<api>.onrender.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key |

**Não** coloque na Vercel: chaves de provider, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`. O build cloud tira Remotion, Chrome, pg e PGlite do bundle. O frontend não usa filesystem local.

**Ambientes da Vercel:** as variáveis `NEXT_PUBLIC_*` entram no BUILD. Marque **Production E Preview** (a branch `cloud-runtime` é publicada como Preview; o domínio de produção serve a branch padrão). Variável faltando no ambiente do deploy = build em modo local, que não funciona na Vercel. Depois de mudar variáveis, gere um novo build daquele deploy.

Depois do deploy:
1. Abra `/api/runtime` no MESMO endereço que você usa: precisa mostrar `"mode":"cloud"`, `"ok":true`, o host da API e `supabaseUrlSet/supabaseAnonKeySet = true` (sem segredos na resposta).
2. Acesse `/login` e entre com o usuário do passo 1.4. O login e a API precisam usar o MESMO projeto Supabase (`NEXT_PUBLIC_SUPABASE_URL` = `SUPABASE_URL` da API = projeto do `DATABASE_URL`); se não, a API responde "o login e o banco usam projetos Supabase diferentes".
3. Coloque o domínio da Vercel em `CORS_ALLOWED_ORIGINS` da API.

## 5. Primeiro teste (sem custo)
1. Configure a API e o worker com `LLM_PROVIDER=mock`, `UGC_PROVIDER=mock`, `RENDERER=mock` e `ALLOW_MOCKS=true` (só para este teste).
2. Crie um vídeo pela Vercel e feche a aba.
3. Acompanhe o log do worker até "tarefa encerrada".
4. Reabra a aba: o projeto mostra a etapa salva no banco.
5. Volte `ALLOW_MOCKS=false` e os providers reais quando for validar de verdade (pagamento só com aprovação explícita na tela).

## Desenvolvimento local

| Situação | Comando |
|---|---|
| Como sempre (tudo no processo, arquivos locais, sem login) | `npm run dev` |
| API e worker contra um Postgres (Supabase local via `supabase start`, ou um projeto de dev) | `npm run dev:api` e `npm run dev:worker` |
| Testes (sem rede, sem API paga): pipelines | `npm test` |
| Testes: repositórios, fila, API e worker com Postgres real em WASM | `npm run test:cloud` |

Para `dev:api`/`dev:worker`, use:
- `PERSISTENCE_DRIVER=supabase`, `DATABASE_URL=...`, `DATABASE_SSL=disable` (local);
- `ASSET_STORE=local`, `LOCAL_ASSET_SIGNING_SECRET=<16+ caracteres>`, `PUBLIC_API_URL=http://localhost:4000`;
- `DEV_AUTH_USER_ID=<uuid>` (proibido em produção) para pular o login;
- no Next, `NEXT_PUBLIC_RUNTIME_MODE=cloud` e `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000`.

Nenhum teste unitário exige Supabase cloud.

## Variáveis por serviço (resumo)

| Variável | Vercel | Render API | Render Worker |
|---|:-:|:-:|:-:|
| `NEXT_PUBLIC_RUNTIME_MODE`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | | |
| `PERSISTENCE_DRIVER`, `ASSET_STORE`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | | ✓ | ✓ |
| `CORS_ALLOWED_ORIGINS`, `PORT`, `RATE_LIMIT_WRITES_PER_MINUTE` | | ✓ | |
| `WORKER_TMP_ROOT`, `WORKER_LEASE_SECONDS`, `WORKER_POLL_INTERVAL_MS`, `WORKER_STALE_TMP_HOURS` | | | ✓ |
| `ANTHROPIC_API_KEY`, `KREA_API_KEY`, `ELEVENLABS_API_KEY`, `RUNWAYML_API_SECRET`, `GOOGLE_AI_API_KEY`, `REMOTION_LICENSE_KEY` | | ✓ | ✓ |
| `LLM_PROVIDER`, `UGC_PROVIDER`, `UGC_REAL_ALLOWED`, `AUDIO_PROVIDER`, `RENDERER`, `ALLOW_MOCKS`, orçamentos | | ✓ | ✓ |
| `SUPABASE_JWT_SECRET` (só projetos com JWT legado) | | ✓ | |

## Migração futura dos jobs locais (não automática)

Os projetos em `data/` e `outputs/` continuam funcionando no modo local (`PERSISTENCE_DRIVER=local`). Para levar o histórico à nuvem no futuro, com um script separado e revisado:
1. Para cada `data/campaigns/*.json` e `data/jobs/*.json`:
   - valide com os schemas Zod;
   - grave no banco com `PostgresPipelineStore(db, <seu userId>)`.
2. Copie `data/ledger.jsonl` e `data/llm-calls.jsonl` para `ledger_entries`/`llm_calls`. Só insert, nunca altere valores.
3. Suba os arquivos de `outputs/{uploads,ugc,videos,audio,renders}`:
   - use as mesmas URIs relativas, com `storageKeyForLocalUri`;
   - registre em `product_assets`/`generated_assets`.
4. Avatares: `data/avatars/*.json` vai para `PostgresAvatarLibraryStore`. As revisões ficam intactas.
5. Rode em modo dry-run primeiro, depois compare contagens e somas do ledger.
