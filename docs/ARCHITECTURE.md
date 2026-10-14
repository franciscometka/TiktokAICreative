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
  │    ledger ← custo real (character-cost × preço)            mesmo que salvar falhe depois
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
