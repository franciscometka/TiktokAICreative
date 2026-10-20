# Arquitetura

## Camadas

```
src/
  app/          UI (Next.js App Router): páginas, Server Actions finas (actions.ts), route handlers de upload.
  components/   Componentes React de apresentação (ui/, create/, campaign/). Sem regra de negócio.
  application/  Casos de uso da UI: formulário → CampaignRequest, view model serializável,
                apresentação de custos, erros de usuário. Chama o PipelineService.
  server/       Runtime do processo Next (um PipelineService + UploadStore) e config pública.
  domain/       Modelos (schemas Zod) + regras puras pequenas. Não importa nada de fora de domain/ e lib/.
  config/       env (validado), modelos Claude por preset (llm-models.ts), tabela de preços, presets.
  costs/        Cálculo de custo (puro), orçamento (puro), avaliação do plano vs preset (pura),
                ledger de custo real, catálogo de preços, câmbio.
  ai/           LlmClient (abstração), anthropic/ (único uso do SDK), prompts versionados,
                saída estruturada com retry limitado, LlmCreativePlanner, MockCreativePlanner.
  providers/    VideoProvider / AudioProvider (interfaces), mocks, factories, polling;
                audio/elevenlabs-audio-provider.ts (único lugar que conhece a ElevenLabs), mp3.ts.
  speech/       Narração (puro): texto falado pt-BR ligado ao escrito, alinhamento → palavras,
                legendas com timing real, AudioFit.
  pipeline/     Máquinas de estado, guards, contexto de orçamento, PipelineService, raiz de composição.
  render/       RenderManifest (puro), timeline/captions/estratégia/props (puros), AssetResolver,
                caminhos de saída, Renderer (interface), MockRenderer, createRenderer,
                remotion/ (RemotionRenderer + servidor de assets: único uso de @remotion/* no app).
  storage/      PipelineStore/CostLedger/LlmCallLog em arquivos (JSON + JSONL atômicos) ou memória.
  lib/          Utilitários genéricos: ids, clock, money, result.
  test/         Fixtures compartilhadas de teste.
remotion/       Composição Remotion (TikTokCreative, componentes, tema, fontes). Imports relativos.
outputs/        Arquivos gerados (ignorados pelo git).
docs/           SPEC, TASKS, DECISIONS, ARCHITECTURE.
```

Regra de dependência (de fora para dentro):

```
app/components → server/application → pipeline → (ai, providers, render, storage, costs) → config → domain → lib
```

- Componentes cliente importam de `application/` apenas tipos e funções puras de apresentação (`cost-presentation`, `campaign-form`, `labels`) — nunca o runtime, o pipeline ou o storage.

- `domain/` não conhece providers, Next, Anthropic nem Remotion.
- Fornecedores concretos só aparecem em `providers/*/` e na raiz de composição.
- Regras de negócio não ficam em componentes React nem em route handlers.

## Planejamento (Lote 1)

```
planCampaign(request)
  ├─ pior caso do LLM ≤ orçamento da campanha?            (senão PlanningBudgetError, nada é chamado)
  ├─ planner.plan()                                         (mock | LlmCreativePlanner)
  │    └─ runStructuredPrompt: Claude (output_config.format) → JSON.parse → Zod → retry ≤ N
  ├─ cada chamada → LlmCallRecord + ledger (custo real do usage, modelo servido)
  ├─ hydrate (IDs internos) → reviewCampaignPlan (evaluate + fitPlanToPreset + reavaliação)
  └─ jobs (planned) → estimateCost (incurred real + futuro estimado) → cost_estimated
```

## Interface (Lote 2)

```
/create (client: CampaignWizard)
  ├─ upload → POST /api/uploads → application.uploadProductImage → LocalUploadStore
  │            (tipo detectado pelos bytes, nome gerado, outputs/uploads/{productId}/)
  └─ "Planejar campanha" → actions.startPlanningAction
        → application.startCampaignPlanning (parseCampaignForm → imagens do store → CampaignRequest)
        → PipelineService.startPlanning   (salva campanha "planning", dispara o planner, devolve o id)
        → router.push(/campaigns/{id})

/campaigns/[id] (server) → application.getCampaignView → buildCampaignView (view model serializável)
  ├─ planning     → PlanningProgress (router.refresh a cada 2,5s; sem progresso inventado)
  ├─ interrupted  → PlanningFailure ("Planejar novamente" com confirmação → retryPlanning)
  ├─ failed       → PlanningFailure (mensagem por errorCode; detalhes técnicos recolhidos)
  └─ planned      → Análise · Hooks · Conceitos · Criativos/Cenas · Custo e aprovação
                     "Gerar por ~R$X" → actions.approveCreativeAction
                       → requestApproval → approve(estimateId) → generate (mídia mock)
                       | BUDGET_EXCEEDED → BudgetDialog → approve(authorize) / resolveBudgetDecision
```

### Execução do planejamento (single-process)

```
startPlanning:  draft → planning (planningRunId, planningStartedAt, planningRuns++) → launch
launch:         activePlanning[campaignId] = runPlanning()   (Map em memória do processo)
runPlanning:    planner.plan()  (fora do lock)
                → lock(campaign): registra custo das chamadas SEMPRE
                → campanha ainda em "planning" com o MESMO runId? senão descarta o resultado
                → planned (+ jobs estimados) | failed (+ errorCode)
leitura:        status "planning" && !activePlanning.has(id)  ⇒  "interrompida" (derivado)
retryPlanning:  ação explícita; planning→failed(interrupted) se preciso → failed→planning (novo runId)
                checa pior caso + custo de planejamento já gasto contra o orçamento da campanha
```

Não é fila durável: se o processo cair, nada retoma sozinho.

## Renderização (Lote 3)

```
GenerationJob(rendering)
  └─ PipelineService.renderPhase
       1. (lock)  buildRenderManifest(plano, produto, assets ativos) → RenderRecord "rendering"
       2. (livre) renderer.render(manifest, { preferredVersion, onProgress })
                    RemotionRenderer:
                      AssetResolver (raízes autorizadas) → allocateRenderDir (vN atômico)
                      → servidor de assets 127.0.0.1 (tokens) → buildCompositionProps (puro)
                      → bundle (1×/processo) → selectComposition → renderMedia (h264, yuv420p, muted)
                      → final.partial.mp4 → final.mp4 + manifest.json
       3. (lock)  RenderRecord completed|failed, outputUri, avisos; ledger "rendering" R$0
UI: AutoRefresh (polling) → getCampaignView (activity, progress real, interrupted, renders)
    → <video src="/api/renders/<campanha>/<criativo>/<vN>"> | ?download=1
```

- Composição: camadas cenas → texto da cena → hook → legendas → CTA → barra de progresso. Props em frames; nenhuma lógica de timing na composição.
- `remotion/types/props.ts` é o contrato entre os dois lados (sem dependências).
- Ver DECISIONS D43–D54.

## Narração (Lote 4)

```
runGeneration (lock da campanha)
  ├─ audioProviderFactory(preço do preset)          sem chave → job failed ANTES de qualquer chamada
  ├─ vídeo por cena (mock) …
  ├─ pauseIfOverBudget                               (estimativa restante × orçamento)
  ├─ generateNarration
  │    buildNarrationScript(cenas) → texto FALADO (pt-BR normalizado) + mapa para o escrito
  │    provider.generateAudio(texto, voz do SpeakerProfile)     UMA chamada, sem retry
  │    ledger ← custo real (caracteres enviados × preço)        mesmo que salvar falhe depois
  │    character-cost (créditos) → providerCharacterCost         só auditoria, nunca no custo
  │    storeNarration: CharacterTiming → TimedWord[] (+ janelas por cena), AudioFit,
  │                    AudioAssetStore.save → outputs/audio/<c>/<k>/vN/{narration.mp3,timing.json,metadata.json}
  └─ afterNarration: fit.action = review → audio_review (espera o usuário) | senão → rendering
renderPhase → buildRenderManifest(timing → captionsFromWords; extendSeconds no fim) → Remotion (<Audio>, AAC)
audio_review ── acceptNarration ──▶ rendering           (sem custo; vídeo mais longo)
completed|audio_review ── startNarrationRegeneration ──▶ generating ──▶ (nova versão vN+1)
```

## Persistência

```
DATA_DIR/
  campaigns/<id>.json   escrita atômica (tmp + fsync + rename)
  jobs/<id>.json        estimativa, aprovação, decisão de orçamento e tentativas dentro do job
  ledger.jsonl          custo real, append-only, fsync por linha
  llm-calls.jsonl       auditoria das chamadas ao LLM
UPLOADS_DIR/            (padrão outputs/uploads)
  <productId>/img_<uuid>.<jpg|png|webp>   imagens do produto; servidas só por GET /api/uploads/<productId>/<arquivo>
AUDIO_DIR/              (padrão outputs/audio)
  <campaignId>/<creativeId>/v<N>/narration.mp3 + timing.json + metadata.json   servidos só por GET /api/audio/...
RENDERS_DIR/            (padrão outputs/renders)
  <campaignId>/<creativeId>/v<N>/final.mp4 + manifest.json   nunca sobrescritos; servidos só por GET /api/renders/...
```

## Fluxo

```
ProductInput ──planCampaign──▶ Campaign(planned) + N GenerationJob(planned)
                                    │ custo do LLM → ledger (nível campanha)
GenerationJob ──estimateCost──▶ cost_estimated   (CostEstimate kind="estimate")
              ──requestApproval──▶ awaiting_approval (+ checagem de orçamento p/ UI)
              ──approve(estimateId)──▶ Approval  | BUDGET_EXCEEDED (decisão da UI)
              ──generate──▶ generating
                   para cada chamada paga: guard (status+aprovação) → checagem de orçamento
                   → provider → ledger (GenerationCost kind="actual") → tentativa registrada
                   | budget_exceeded ──resolveBudgetDecision(cancel|authorize)
              ──▶ rendering ──▶ completed (RenderManifest + outputUri + RenderRecord vN)
completed ──regenerateScene──▶ (checa limite de tentativas e orçamento) ──▶ completed
completed|failed ──startRerender (mídia completa)──▶ rendering ──▶ completed (vN+1)
```

## Estados

Job (`pipeline/states.ts`):

| De | Para |
|---|---|
| planned | cost_estimated, cancelled |
| cost_estimated | cost_estimated, awaiting_approval, cancelled |
| awaiting_approval | generating, cost_estimated, cancelled |
| generating | rendering, budget_exceeded, audio_review, failed, cancelled, completed* |
| budget_exceeded | generating, cancelled |
| audio_review | rendering (aceitar), generating (gerar narração de novo), cancelled |
| rendering | completed, failed |
| completed | generating (regeneração), rendering (renderizar de novo) |
| failed | cost_estimated, cancelled, rendering (renderizar de novo, só com mídia completa) |
| cancelled | — |

\* só quando uma regeneração falha e o vídeo anterior é mantido.

Campanha: `draft → planning → planned | failed`, `failed → planning`. Na interface, `planning` sem execução no processo aparece como **interrompida** (estado derivado, não persistido). O mesmo vale para job em `generating`/`rendering` sem execução: badge "Interrompido" e retomada só por ação explícita.

## Sistema de custos

- **Preços**: `config/pricing.ts` → `StaticPricingCatalog`. Unidades: `per_second`, `per_1000_characters`, `per_1m_input_tokens`, `per_1m_output_tokens`, `per_1m_cache_write_tokens`, `per_1m_cache_read_tokens`, `per_generation`.
- **Custo real do LLM** (`llmCallCostLines`): entrada, saída, escrita e leitura de cache, cada uma com sua tarifa.
- **Consumo** (`Usage`): `{ seconds, characters, inputTokens, outputTokens, generations }`; `quantityFor(unit, usage)` escolhe o campo certo. Trocar um provider de "por segundo" para "por geração" não muda o pipeline.
- **Estimativa** (`estimateCreativeCost`): `incurred` (rateio real do planejamento) + linhas futuras (uma por cena com IA, áudio, render) = `projectedTotal`; cotação usada; flag de preço provisório.
- **Avaliação do plano** (`evaluatePlanAgainstPreset`, `fitPlanToPreset`): segundos de IA vs preset, ajuste determinístico sem nova chamada.
- **Faixa do preset** (`estimatePresetRange`): para os cards antes do planejamento.
- **Custo real** (`buildActualCost` + `CostLedger`): um registro por chamada, com `simulated` para mocks. Append-only.
- **Resumo real** (`summarizeActualCosts`): total, mantido, descartado, por categoria.
- **Orçamento** (`checkBudget`, `authorizeOverBudget`): puro, em centavos; ver DECISIONS D5/D6.

## Como adicionar um provider real (ex.: Veo)

1. Adicionar o preço oficial em `config/pricing.ts` (`isPlaceholder: false`) e apontar o preset.
2. Implementar `VideoProvider` em `providers/video/veo-video-provider.ts`, devolvendo `billedUsage` real.
3. Adicionar `"veo"` em `VIDEO_PROVIDER_IDS` (`config/env.ts`) e um `case` em `createVideoProviderFactory`.
4. Testes com HTTP mockado. Nenhuma mudança em domain/ ou pipeline/.

Pré-requisito já atendido: ledger persistido em `ledger.jsonl`.


## Vídeo real Runway (Lote 5)
`VIDEO_PROVIDER=runway` → configuração de vídeo anexada aos settings de NOVAS campanhas → estimativa por cena (duração comprada 5/10s) → aprovação existente → guard/orçamento → preflight de todas as imagens/prompts → POST único → task id persistido → polling limitado → download MP4 → ledger real → `LocalVideoAssetStore` vN → tentativa ativa → manifest → AssetResolver (inclui VIDEOS_DIR) → OffthreadVideo mudo → MP4 final pelo renderer existente. Sem chave/entrada inválida, falha antes de qualquer mídia paga. Sem retry pago; restart só mantém auditoria e estado interrompido. `scripts/video-real.ts` exercita o mesmo pipeline com uma cena e outros providers mock. Ver D69–D72 e `docs/RUNWAY.md`.


## Presenter de áudio (Lote 5)

`PresenterProvider` é separado de `VideoProvider`. `RunwayPresenterProvider` envia exclusivamente áudio a `/v1/avatar_videos` (`gwm1_avatars`). HTTP sanitizado compartilhado em `providers/runway-http.ts`; nenhum retry. `pipeline/presenter-flow.ts` mantém a intenção e task duráveis, reutiliza aprovação/orçamento/ledger e grava o clipe com `VideoAssetStore` e a integridade existente. `speech/presenter-audio.ts` resolve as janelas do alignment e recorta PCM com FFmpeg local. `pipeline-service` antecipa a narração quando há presenter e alinha a timeline do render à fala real. UI seleciona preset, mostra custo/status/preview por IDs e confirma regeneração. A CLI isola uma chamada em nova campanha, copiando áudio existente sem novo TTS. Ver [PRESENTERS.md](PRESENTERS.md) para contratos e limites.

## Orquestração híbrida por etapa (D76)

`createHybridPipelineService` usa a mesma composição/storage do fluxo offline, acrescentando factories por modo e capabilities sem segredos. `domain/execution.ts` define modos/etapas; os schemas de Campaign/GenerationJob persistem escolhas, intenções, revisão e aprovações. `PipelineService.quotePlanning/quoteStage` só leem/calculam. `executePlanning/executeStage` verificam cotação e orçamento sob lock, persistem autorização e iniciam trabalho em background. Cada etapa real termina sem encadear outra paga.

`config/execution-policy` protege transportes reais com escopo efêmero limitado a uma criação; mocks e transportes falsos preservam injeção de dependências. `application` monta cotações e bloqueios para `StageExecutionPanel`; Server Actions validam argumentos e delegam. O render real reusa AssetResolver/Remotion e seu registro versionado. Retomada Runway restaura a referência para polling/download sem POST novo; intenção sem ID requer reconciliação externa. Compatibilidade: campos novos opcionais, projetos antigos sem conversão destrutiva. Guia em HYBRID-WORKFLOW.md.

## Diagnóstico e preflight (Lote 5.1 / D77)

`loadAppConfigSafe` mantém a aplicação acessível quando um valor local é inválido: somente o campo inválido volta ao default seguro e uma mensagem sanitizada chega ao diagnóstico. `runtimeReadiness` combina seleção de provider, presença booleana das credenciais e inspeção local do navegador. Nenhuma chave é serializada.

`detectRemotionBrowser` consulta apenas o filesystem; nunca chama `ensureBrowser`. A preparação continua exclusiva de `npm run render:setup`, enquanto `npm run render:check` é read-only e sem rede.

`quotePlanning` e `quoteStage` expõem checks de preflight junto da cotação. O painel os mostra antes da confirmação; `executePlanning`/`executeStage` recalculam a mesma cotação sob lock e só então criam a autorização efêmera de uma unidade. `application/job-workflow.ts` deriva a próxima ação recomendada do estado e das cotações, sem duplicar regras de execução no componente.

## Fluxo simples e execução automática (D78)

`simpleFlow` seleciona os presets de UX sem alterar settings de campanhas antigas. `SimpleVideoWorkspace` consome apenas o view model serializável: storyboard, timeline, status, custo e URLs por ID. `updateStoryboardScene` valida a cena, recusa UGC e jobs com mídia, revisa o plano, atualiza o estado das cenas e recalcula a estimativa sob o lock da campanha.

`quoteJob` cria o teto conservador e um fingerprint das entradas, modos, estimativa e revisão do storyboard. `authorizeAndRunJob` persiste `jobAuthorization` e inicia `runAuthorizedJob` no registro de jobs ativos. A orquestração chama as mesmas etapas híbridas uma a uma; antes de cada unidade compara gasto desde a aprovação + cotação com o teto. Cada provider continua protegido por `withRealStageAuthorization`. Estado interrompido é derivado e só continua após novo clique.


## AI UGC (Lote 5.3 / D79–D85)
- Domínio: `domain/ugc.ts` (identidade, referência versionada, estado do job, consistência por cena, perfil de biblioteca futura). `GenerationJob.ugc`, `MediaAttempt.ugc`, `CampaignRequest.creativeMode/ugc`.
- Config: `config/ugc.ts` (identidade, ambiente, produto-âncora e planos), `config/ugc-models.ts` (Nano Banana/Veo, capacidades, durações e preset → modelo/resolução) e `config/pricing.ts` (fonte/data oficial).
- Providers: `providers/ugc/` — `UgcReferenceProvider`/`UgcVideoProvider`, mocks, builders puros e adapters `UgcReferenceProviderGoogle`/`UgcVideoProviderVeo` sobre transportes Google reais (`google-http.ts`, `google-transports.ts`, Lote 5.4). A factory só cria REAL com `config/ugc-readiness.ts` completo (opt-in `UGC_REAL_ALLOWED`); scripts `scripts/ugc-*-real.ts` com intenções em `DATA_DIR/ugc-validation`.
- Roteiro: `ai/ugc-script.ts` (regras de fala), `ai/mock-ugc-planner.ts`, prompt `campaign-plan@1.5.0`.
- Fluxo: `pipeline/ugc-flow.ts` (`generateUgcReference`, `generateUgcScene`), integrado em `PipelineService` (`quoteStage`/`performHybridStage`, `approveUgcReference`, `regenerateUgcReference`, `updateUgcIdentity`, `resumeAfterUgcDecision`). Ordem `ugc_reference → narration → ugc_video → avatar → scenes → render`.
- Storage: `storage/ugc-asset-store.ts` (`UGC_DIR`, vN atômico), rota `api/ugc/[campaignId]/[creativeId]/[version]`.
- Render: `ManifestAsset.clipAudio` + guard de áudio duplicado; `OffthreadVideo` desmutado só em cenas com áudio próprio e o encoder preserva AAC quando a única fonte é o áudio nativo do clipe.
- Durabilidade: referência e cena persistem intenção antes do POST; vídeo guarda `ugcVideoOperations` com operation ID, duração pedida e custo estimado. Retomada consulta/poll/download pelo ID, sem novo submit; timeout/cobrança incerta pausa.
- UI: `application/ugc-view.ts`, `components/campaign/ugc-reference-panel.tsx`, cartões do storyboard com quem/segura/fala/faz.

## UX V2, Avatares, Roteiro mestre e Voice Lock (Lote 6 / D95–D98)
- UI: `components/v2/` (design system `ui.tsx`, `app-shell.tsx`, `create-video-form.tsx` + `create-video.tsx`, `project-v2-panel.tsx` + `project-v2.tsx`, `project-cards.tsx`, `avatar-form.tsx`, `tag-input.tsx`, `voice-profile-form.tsx`). Componentes presentacionais recebem as Server Actions por props (testáveis com `renderToStaticMarkup`).
- Rotas: `/` (Home V2), `/create` (Create V2; `?from=` e `?mode=advanced` = wizard completo), `/projects` (cards + filtros; `/campaigns` redireciona), `/avatars`, `/avatars/new`, `/avatars/[id]`, `/settings` (Vozes + Avançado/Diagnóstico). `/campaigns/[id]`: V2 para `uxVersion: 2`, tela completa para antigos e com `?view=advanced`.
- Aplicação: `application/create-v2.ts` (`startVideoV2`, `resolveAvatarSelection`, `v2Estimates`), `application/avatar-actions.ts` (CRUD, vozes, views sem `providerVoiceId`), `application/project-v2-view.ts` (fase/progresso/aprovação/erro/resultado e cards).
- Domínio: `domain/avatar.ts`, `domain/avatar-selection.ts`, `domain/master-script.ts`, `domain/video-speech.ts` (capability matrix, `resolveVoiceLock`, `masterAudioSegments`), `domain/change-request.ts`. Pedido: `uxVersion`, `targetDurationSeconds`, `avatar` (seleção + snapshot), `personalization`, `voiceLock`; job: `avatar`, `voiceLock`, `masterAudio`; plano: `masterScript`.
- IA: `ai/master-script.ts`, `ai/ugc-style-guide.ts`, prompt `campaign-plan@1.8.0`; `config/duration-targets.ts` + `withTargetDuration` (presets por duração).
- Storage: `storage/avatar-store.ts` (`DATA_DIR/avatars/<id>.json` com revisões, `DATA_DIR/voice-profiles.json`).
- Pipeline: `startPlanning` decide Voice Lock pela matriz do provider; `runPlanning` aplica o roteiro mestre antes do Presenter Only; narração LOCKED_VOICE grava `job.masterAudio`; `ugcSpeechMatrix()` alimenta o Diagnóstico.

## Presenter Only (Lote 5.7 / D94)
- Plano: `ai/ugc-presenter-only.ts` (`applyPresenterOnly`, `previewPresenterTimeline`), presets `UGC_PRESENTER_PLANS` e `PRESENTER_POLICY` em `config/edit-policy.ts`; prompt `campaign-plan@1.7.0`; `validatePresenterScript` em `ai/ugc-script.ts`.
- Edição: `render/presenter-edit-plan.ts` (`buildPresenterEditPlan`, `presenterWindow`, `captionPhrases`/`captionLines`, `auditEditTimeline`), escolhido por `editPlanVersion: 3` em `render/edit-manifest.ts`.
- Remotion: `remotion/components/CaptionV3.tsx` (legenda única, âncora fixa) usada por `EditedCreative` (V2 e V3); `tiktok-creative@1.4.0`.
- Validação pós-render: `render/remotion/media-probe.ts` (ffprobe local) no `RemotionRenderer`, registrada em `mediaCheck`.

## Creative Editor V2 (Lote 5.6 / D91)

```
planner (mock | Claude campaign-plan@1.6.1) → JSON parse → normalização de campos derivados → validação → hydrate
  → ai/ugc-editorial.applyUgcEditorial   (A-roll/B-roll, overlay, cutReason, continuidade, catálogo → reference_detail)
  → reviewCampaignPlan → jobs (editPlanVersion=2)
ugc_reference → Product Fidelity Gate (domain/fidelity: pending → approved | needs_review | rejected; humano)
ugc_video     → prompt com continuidade + fidelidade (ai/ugc-video-prompt, usado por Krea e Google)
render        → storage/video-asset-store (silencedetect local; pausas reais persistidas)
              → render/edit-plan.buildEditPlan (puro: handles ajustados à pausa medida,
                fallback mantém A-roll; overlays B-roll mudos só em junções seguras,
                faixas de áudio contínuas e sem sobreposição,
                legendas V2, hook deliberado, CTA, usage gerado × usado)
              → render/edit-manifest (RenderManifest.edit) → composition-props (EditProps em frames)
              → remotion/compositions/EditedCreative (OffthreadVideo mudo + trimBefore; <Audio> do A-roll com fades)
```

- `domain/edit.ts`: `SceneEdit` (só no ScenePlan hidratado; o JSON do LLM não muda), `EditPlan` e `assertValidEditPlan` (cobertura contínua, motivo de corte, uma faixa por A-roll, nenhum áudio sobreposto, B-roll nunca fonte de áudio).
- `render/audio-silence.ts`: análise FFmpeg local e determinística; sem pausa segura o corte visual permanece no A-roll.
- `config/edit-policy.ts`: handles, tolerância de pausa, limite de B-roll estático, fades, punch-in, janela do CTA, legenda e presets editoriais (`UGC_EDITORIAL_PLANS`).
- Compatibilidade: sem `editPlanVersion`/`manifest.edit`, tudo segue pela montagem linear do Lote 3; `external_lipsync` também.
