# Cloud Runtime (Lote 7 · D101–D108)

O computador do usuário não precisa ficar ligado depois que um vídeo é enviado. O trabalho pesado roda num worker no Render, o estado fica no Supabase Postgres e os arquivos no Supabase Storage. O modo local (`npm run dev`) continua igual e é o padrão.

## Arquitetura final

```
Browser ──HTTPS──► Vercel (Next.js, só interface)
                      │  Server Components / Server Actions
                      │  Authorization: Bearer <JWT do Supabase Auth>  (cookie httpOnly)
                      ▼
                 Render Web Service  (npm run start:api)
                      │  valida JWT + input, calcula orçamento, persiste, ENFILEIRA (202)
                      ▼
              Supabase Postgres  ◄──────────────┐
   campaigns · jobs · job_queue · ledger …      │ claim (FOR UPDATE SKIP LOCKED), lease, heartbeat
                                                │
                 Render Background Worker  (npm run worker)
                      │  hidrata /tmp/tiktok-ai/{jobId}/ do Storage
                      │  Claude · referência · Krea/Veo · ElevenLabs · FFmpeg · Remotion · mediaCheck
                      │  publica arquivos novos → Storage; limpa o temporário
                      ▼
              Supabase Storage (bucket privado tiktok-media)
                      ▲
Browser ──PUT direto (URL de upload assinada)──┘   ◄── fotos do produto/avatar
Browser ──GET (redirect para URL assinada de 10 min)── vídeos/imagens
```

Princípio central: **nada importante depende de disco local**. O disco do worker é temporário (cópias hidratadas e arquivos recém-gerados). A fonte de verdade é o Supabase.

## Como o código foi encaixado (sem duplicar regra de negócio)

| Peça | Local (`npm run dev`) | Cloud |
|---|---|---|
| Onde roda o trabalho pesado | no processo Next (`activeJobs`) | worker, via fila durável |
| `PipelineService` | igual | igual. Muda só `deps.dispatcher`, `deps.activity` e `deps.locks` |
| Campanhas/jobs | `FilePipelineStore` (JSON) | `PostgresPipelineStore` (documento Zod + colunas) |
| Ledger / LLM calls | JSONL append-only | `ledger_entries` / `llm_calls` (append-only também por trigger) |
| Avatares | `FileAvatarLibraryStore` | `PostgresAvatarLibraryStore` |
| Uploads | `LocalUploadStore` | `CloudUploadStore` (upload direto ao Storage + `product_assets`) |
| Arquivos gerados | pastas `outputs/...` | mesmas URIs relativas no workspace temporário, publicadas no Storage (`generated_assets`) |
| Lock por campanha | mutex em memória | advisory lock do Postgres (API × worker) |
| "Está em andamento?" | mapa em memória | fila (`queued`/`running`): fechar o navegador não interrompe |
| Telas V2 | `getRuntime()` | Render API (mesmos view models de `application/`) |

O ponto único da troca é `src/pipeline/dispatch.ts`:
- `JobRun` é a descrição serializável de uma execução: `authorized`, `hybrid_stage`, `hybrid_mocks`, `continue`, `render` ou `narration_regen`.
- Sem dispatcher, `dispatchJob` executa no processo, como antes.
- Com dispatcher, `dispatchJob` só persiste a tarefa e devolve `QUEUED`. O worker chama `runJobTask(jobId, run)`, que executa exatamente o mesmo código.

## Fila durável (D103)

- Tabela `job_queue` no próprio Postgres; não há serviço extra. Status possíveis: `queued`, `running`, `awaiting_approval`, `blocked`, `failed`, `completed`.
- **Claim exclusivo:** `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`.
  - Dois workers nunca pegam a mesma tarefa.
  - O índice único parcial `(campaign_id) WHERE status='running'` impede duas tarefas da mesma campanha ao mesmo tempo.
- **Dedupe:** existe no máximo uma tarefa ativa por chave (`planning:<campanha>` ou `job:<job>`). Clique duplo e spam não duplicam.
- **Lease + heartbeat:** a cada lease/3 o worker renova a tarefa. Se o worker morre, o lease expira e outro worker decide a retomada.
- Só o dono do lease encerra a tarefa. Um worker "zumbi" que volta não sobrescreve nada.

## Idempotência e operações pagas (D104)

A regra absoluta continua: **nenhuma chamada paga é refeita automaticamente.**
- O pipeline já grava a intenção ANTES do POST: `stageIntents: running`, referência `submitting`, operação Veo/Krea `submitting`/`uncertain`. Agora isso fica no banco e sobrevive a restart, deploy e timeout.
- `job_attempts` projeta cada operação paga com `attemptId`, `jobId`, `stage`, `provider`, `model` e `status` (`started`, `submitted`, `confirmed`, `failed` ou `uncertain`).
- Antes de executar, o pipeline continua conferindo resultado confirmado (tentativa ativa, operação já liquidada).

Retomada após queda do worker (`CloudWorker.recoverExpired`):

| Situação | Decisão |
|---|---|
| Operação paga em voo (marcador sem confirmação) | `blocked`, motivo registrado. Nada reenviado; o usuário retoma explicitamente |
| Planejamento pago (Claude) interrompido | `blocked`. Planejar de novo é ação explícita, com nova aprovação |
| Render interrompido no meio | `failed`. "Renderizar novamente" é grátis e explícito |
| Nada em voo (entre etapas ou etapa grátis) | volta para a fila e continua a sequência JÁ aprovada, até `max_attempts` |

Um retry pago passa por `/v1/jobs/:id/generate` com uma cotação nova aprovada (teto do job). `/v1/jobs/:id/retry` só faz retomada sem custo.

Clique duplo e retry de rede no HTTP usam `Idempotency-Key` (tabela `idempotency_keys`):
- mesma chave com o mesmo corpo devolve a mesma resposta;
- mesma chave com outro corpo dá 422;
- chave ainda em execução dá 409.

## Banco (Supabase Postgres)

A migration versionada está em `supabase/migrations/20261021120000_cloud_runtime.sql`. Aplique com `npm run db:migrate` ou `supabase db push`.

| Tabela | Conteúdo |
|---|---|
| `profiles` | usuário (FK `auth.users` no Supabase) |
| `campaigns`, `projects` | campanha = documento Zod; projeto V2 = projeção para listagem |
| `jobs` | GenerationJob (documento) + `status`, `current_stage`, `progress_stage` |
| `job_queue` | fila durável |
| `job_attempts` | operações pagas |
| `job_events` | histórico de status/progresso |
| `ledger_entries` | append-only (trigger recusa UPDATE/DELETE): stage, provider, model, custo estimado/confirmado, moeda, status |
| `llm_calls` | auditoria das chamadas ao Claude |
| `avatars`, `avatar_revisions` (congeladas), `voice_profiles` | biblioteca de avatares |
| `product_assets`, `generated_assets` | índice dos arquivos (bucket + path + URI local) |
| `ugc_references`, `render_jobs` | projeções consultáveis |
| `change_requests` | pedidos de alteração interpretados (sem execução) |
| `idempotency_keys` | idempotência HTTP |

O schema também tem:
- constraints de status e de IDs seguros;
- FKs;
- timestamps;
- índices: jobs por status e por usuário, projetos por usuário, ledger por job, assets por projeto, claim da fila.

RLS fica ligado em todas as tabelas, com leitura só do dono (`user_id = auth.uid()`). A escrita é só do backend (service role). No Postgres puro dos testes esses blocos são ignorados.

## Storage (D106)

Um bucket privado (`tiktok-media`), criado pela migration:

```
users/{userId}/uploads/{productId|avatarId}/img_<uuid>.png
users/{userId}/projects/{campaignId}/references/{creativeId}/v1/...
users/{userId}/projects/{campaignId}/clips/{sceneId}/v1/clip.mp4
users/{userId}/projects/{campaignId}/audio/{creativeId}/v1/...
users/{userId}/projects/{campaignId}/renders/{creativeId}/v1/final.mp4
```

- `AssetStore` (`put`, `get`, `delete`, `exists`, `getSignedUrl`, `createSignedUpload`, `downloadToTemp`) tem duas implementações:
  - `SupabaseAssetStore`: REST, com a service role só no header;
  - `LocalAssetStore`: dev/teste, com HMAC.
- O banco guarda **bucket + path**, nunca URL assinada. A URL é gerada sob demanda com validade curta (`SIGNED_URL_TTL_SECONDS`, padrão 10 min) e só para arquivo registrado do próprio usuário.
- O documento do job continua com a URI local relativa (`outputs/videos/...`). Por isso o pipeline roda igual no local e no worker.

## Upload direto (D106)

1. Browser → Next `/api/uploads/direct` (`authorize`). A Render API valida tipo e tamanho, cria `product_assets` em `pending` e devolve UMA URL de upload assinada.
2. O browser envia o arquivo direto ao Supabase Storage. O arquivo não passa pela Vercel nem pela API.
3. Browser → `/api/uploads/direct` (`complete`). A API baixa o objeto e confere os bytes reais (assinatura do formato, tipo declarado, limite de 8 MB). Se estiver ok, o upload vira `ready`. Se não, vira `rejected` e o objeto é apagado.

## Fluxo de geração

1. **Criar vídeo:** `POST /v1/projects` com `Idempotency-Key`. A API persiste a campanha (`planning`), enfileira `planning:<id>` e responde 202.
2. **Worker:** faz claim, roda o planner e grava o plano e os jobs estimados (`ready_to_generate`).
3. **Gerar vídeo:** `POST /v1/jobs/:id/generate {token}` aprova o teto do job e enfileira `job:<id>` com `{kind:"authorized"}`. Responde 202.
4. **Worker:** gera a referência e pausa em `awaiting_reference_approval`. A tarefa fica `awaiting_approval`.
5. **Aprovar referência:** `POST /v1/jobs/:id/references/:ref/approve` enfileira de novo, com a mesma autorização.
6. **Worker:** gera os trechos Krea/Veo, faz FFmpeg/silencedetect, Remotion e mediaCheck, faz upload e termina em `completed`.
7. **Frontend:** faz polling (`router.refresh` a cada 3s, que chama `GET /v1/projects/:id`; ou `GET /v1/jobs/:id`). O progresso vem do banco.

Passos de progresso persistidos: `planning`, `awaiting_approval`, `reference`, `awaiting_reference_approval`, `video_generation`, `rendering`, `uploading`, `completed`, `failed`, `blocked`, `cancelled`.

A UX continua com os mesmos quatro passos: Preparando roteiro, Preparando apresentadora, Criando vídeo, Finalizando.

**Fechar o navegador:** nada depende da conexão aberta. O teste `cloud-runtime.test.ts` cobre esse caminho: cria o job, para de consultar, o worker termina e, depois de reiniciar a API, o estado é recuperado do banco.

## Workspace temporário (D104)

- O caminho é `{WORKER_TMP_ROOT}/{jobId}/`, que vira o cwd da tarefa. Por isso há uma tarefa por vez por processo; para escalar, adicione instâncias.
- Antes da tarefa, o worker hidrata o workspace: fotos do produto, foto do avatar e arquivos já gerados do projeto.
- Depois da tarefa, com sucesso ou falha, publica os arquivos novos (sem sobrescrever) e apaga o workspace.
- Se a publicação falhar, o workspace fica no disco e a tarefa vira `blocked`.
- Na subida, apaga workspaces abandonados mais velhos que `WORKER_STALE_TMP_HOURS`.

## Segurança

- A service role e as chaves de provider ficam só na API e no worker.
- `assertNoPublicSecrets` recusa:
  - `NEXT_PUBLIC_*` com nome de segredo;
  - `NEXT_PUBLIC_*` com o mesmo valor de um segredo do servidor.
- Um teste estático percorre o grafo de imports de todos os componentes `"use client"`. Nenhum pode ler variável não pública nem importar código de servidor.
- **JWT:**
  - assinatura conferida (ES256/RS256 por JWKS ou HS256 legado), mais `iss`, `aud`, `exp` e `role`;
  - o userId vem só do `sub`;
  - toda query é filtrada pelo dono;
  - job só entra em campanha do mesmo usuário.
- **CORS:** só as origens de `CORS_ALLOWED_ORIGINS`; `*` é recusado no startup.
- **Erros:**
  - sanitizados, sem stack, SQL ou URL interna;
  - banco fora dá 503 "Serviço temporariamente indisponível.";
  - o frontend mostra a mesma frase quando a API está fora.
- O logger é estruturado e redige `authorization`, tokens, cookies, valores de segredo e a query string das URLs assinadas.
- O rate limit de escrita é por usuário, além da idempotência.

## Presença do worker (L8.1)

- Tabela `worker_heartbeats` (migration `20261022120000_worker_heartbeats.sql`): uma linha por processo de worker, com chave = hash opaco do id do processo (nunca hostname, path, env ou segredo).
- O worker faz upsert a cada 30s (`WORKER_HEARTBEAT_INTERVAL_MS`). Sem sinal por 2 min (`WORKER_OFFLINE_AFTER_MS`) vira offline. Os dois limites ficam em `src/application/worker-status.ts`.
- Totalmente separado da fila: não toca `job_queue`, lease nem processamento. Falha de heartbeat só gera um aviso no log; o worker continua.
- `GET /v1/worker` (autenticado) responde `{ state, lastSeenAt }`:
  - `online`: sinal recente;
  - `offline`: o último sinal ficou velho;
  - `unknown`: nunca houve sinal. Não é offline: falta evidência.
- No modo local, o shell mostra "Geração local".

## Créditos (L8.2)

- **Fonte da verdade:** `ledger_entries`, sem mudança. Não há tabela de saldo, débito gravado, carteira nem cron de reset.
- **Cálculo:**
  - uso do mês = Σ custo REAL (`status = confirmed`, sem simulados) × `CREDITS_PER_BRL`;
  - saldo = `max(0, MONTHLY_CREDIT_ALLOWANCE − uso)`;
  - excedente = `max(0, uso − franquia)`, só informativo.
- **Período:** é o mês corrente em `CREDITS_TIMEZONE` (padrão `America/Sao_Paulo`).
  - O banco e o ledger guardam UTC. O corte é sempre explícito nesse fuso, nunca o fuso do servidor.
  - O PC local está em Brasília; Render, Vercel e Supabase rodam em UTC.
- **Arredondamento** (`src/costs/credits.ts`):
  - estimativa: para cima;
  - real: matemático, somando em micro-reais antes de converter;
  - partes (categoria, dia, linha): maior resto, somando exatamente o total.
- **API:** `GET /v1/credits` (autenticado) devolve franquia, uso, saldo, excedente, período, vídeos, `≈ vídeos de 30s`, consumo por serviço, uso diário e histórico agrupado por projeto. `?summary=1` devolve só o saldo, para o shell.
- **Fora da resposta:** provider, modelo, prompt e ids de entrada/job.
- **"≈ N vídeos de 30s":**
  - usa a média real dos últimos 10 vídeos de 30s, quando há pelo menos 3;
  - senão, usa a estimativa atual de 30s (Equilibrado), se não for provisória;
  - senão, não aparece.

## Limites conhecidos

- No cloud, a tela técnica antiga (`?view=advanced`, `/create?mode=advanced`, `/jobs`) mostra "Disponível no modo local". A UX V2 inteira funciona.
- Os jobs locais antigos não são migrados automaticamente. O procedimento futuro está em `DEPLOYMENT.md`.
- O worker roda uma tarefa por processo. Não há autoscaling sofisticado nem CDN/domínio custom obrigatório.
- Pagamentos, créditos e planos SaaS ficam fora deste lote.
