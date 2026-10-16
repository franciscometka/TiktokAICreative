# CLAUDE.md — TikTok AI Creative Factory

Guia para futuras sessões do Claude neste repositório. Leia também `docs/DECISIONS.md` antes de mudar arquitetura.

## Objetivo
Transformar dados de um produto em vários criativos verticais (MP4 1080x1920) para TikTok Shop:
produto → análise/hooks/conceitos/roteiro/cenas (Claude) → validação + ajuste ao preset → **estimativa de custo** → **aprovação humana** → vídeo (provider) → áudio → Remotion → MP4.
Custo é preocupação central; nada pago de mídia acontece sem aprovação explícita.

## Estado atual
- Lote 5.3 AI UGC (D79–D85): modo `creativeMode: "ai_ugc"` com providers separados do Presenter; referência pessoa+produto versionada e APROVADA antes das cenas; identidade persistida; áudio nativo ou lip-sync, nunca duplicado. Lote 5.4 (D86–D87): transporte REAL Google (`gemini-3.1-flash-image` + Veo 3.1) implementado, DESLIGADO por padrão: exige `GOOGLE_AI_API_KEY` + `UGC_PROVIDER=google` + `UGC_REAL_ALLOWED=true`. Intenção com hash/teto antes do POST, `uncertain` sem reenvio, retomada por operation ID. Nenhuma chamada real feita. Ver `docs/AI-UGC.md`.
- AI UGC via Krea (D88): `UGC_PROVIDER=krea` + `KREA_API_KEY` + `UGC_REAL_ALLOWED=true` (Nano Banana 2 + Veo 3.1 Fast com áudio, 4/6/8s). Arquivos `krea-*` separados; Google intacto. Sem validação paga.
- Auditoria Krea D89: upload de asset durável antes do POST pago, retomada/reuso via `GET /assets/{id}`, marcador de envio pago antes da geração, CLI de referência seleciona Krea e download aceita somente HTTPS público revalidado. Nenhuma chamada real feita.
- Redesign D78: fluxo principal simplificado (produto → preset/apresentador → storyboard → teto único → pipeline automático → resultado). Novos projetos usam Econômico 15–20s, Equilibrado 20–30s e Premium 30–45s. Configuração técnica fica recolhida; campanhas antigas preservam settings. Nenhuma validação paga deste fluxo.
- Lote 5.1: diagnóstico público sem segredos, configuração inválida com fallback seguro para MOCK, preflight local por ação, navegador Remotion detectado sem download e "Próxima etapa recomendada" no job. Protocolo completo validado só com mocks/transportes falsos; nenhuma chamada paga.
- Prompt anterior (substituído pela 1.5.0): `campaign-plan@1.4.0` (inclui brief e valida preservação do roteiro manual; ainda sem validação paga).
- Interface híbrida por etapa (D76): MOCK default; REAL apenas com provider configurado, cotação e confirmação por unidade. Nenhuma cascata paga. Planejamento real aguarda draft/aprovação. Guia: `docs/HYBRID-WORKFLOW.md`. CLI `--confirm` isolado continua bloqueada.
- Lotes 0 a 5 implementados (Runway ainda sem validação paga). Lote 4 = narração real pt-BR com ElevenLabs (opcional), legendas com timing real, AudioFit/revisão, áudio versionado e MP4 com AAC. Lote 2 = experiência `/create` → `/campaigns/[id]` (planejar, revisar, custo, aprovar). Lote 3 = render real do MP4 com Remotion (local, R$0).
- Planejamento: `LLM_PROVIDER=mock` (padrão, sem custo) ou `anthropic` (Claude real, pago).
- Renderer: `RENDERER=mock` (padrão, sem arquivo) ou `remotion` (MP4 real). Narração: `AUDIO_PROVIDER=mock` (padrão, "MODO DE TESTE", sem som) ou `elevenlabs` (real, paga). Vídeo IA: `VIDEO_PROVIDER=mock|runway` (default mock); Runway Gen-4 Turbo real, ver `docs/RUNWAY.md`.
- Histórico de prompt: `campaign-plan@1.0.1` (1.0.0 + regras da D42). A 1.0.0 foi validada com o Claude real em 2026-10-14; a 1.0.1 ainda não. ElevenLabs validada com UMA chamada real em 2026-10-14 (D68).
- **Não avance de lote sem instrução do usuário.** Ver `docs/TASKS.md`.

## Comandos
```bash
npm run dev               # Next.js em http://localhost:3000
npm test                  # Vitest — NUNCA chama API paga
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit
npm run check             # lint + typecheck + test (obrigatório antes de encerrar)
npm run build             # build de produção
npm run plan:real         # validação manual com Claude real: sem --confirm só mostra o pior caso
npm run test:integration  # testes PAGOS; só rodam com RUN_PAID_TESTS=1 e ANTHROPIC_API_KEY
npm run tts:real          # validação manual ElevenLabs: sem --confirm só mostra custo; com --confirm UMA chamada curta
npm run ugc:reference:real # Teste A AI UGC: sem --confirm só dry-run; com --confirm UMA referência Gemini; --approve <id>
npm run ugc:video:real     # Teste B AI UGC: exige referência aprovada; --confirm UMA cena Veo; --resume <id> sem POST
npm run render:setup      # baixa o Chrome Headless Shell do Remotion (1× por máquina)
npm run render:check      # somente verifica localmente; nunca baixa navegador
npm run test:render       # teste PESADO: MP4 real de 3s (fora do npm test e do check)
```
Para ver a tela de processamento com o mock: `MOCK_PLANNER_DELAY_MS=20000` em `.env.local`.

## Arquitetura (resumo — detalhes em docs/ARCHITECTURE.md)
- `src/app/` — páginas (`/`, `/create`, `/campaigns`, `/campaigns/[id]`), `actions.ts` (Server Actions FINAS: validam formato e delegam), `api/uploads` (POST upload, GET imagem).
- `src/components/` — apresentação (`ui/` primitivos, `create/` wizard, `campaign/` revisão/custo/aprovação). Sem regra de negócio.
- `src/application/` — casos de uso da UI (`campaign-actions.ts`), formulário (`campaign-form.ts`), view model serializável (`campaign-view.ts`), apresentação de custos (`cost-presentation.ts`), erros de usuário (`user-errors.ts`), rótulos.
- `src/server/runtime.ts` — um `PipelineService` + `LocalUploadStore` por processo (em `globalThis`); `getPublicConfig()` = única config enviada à UI.
- `src/domain/` — schemas Zod = modelos. `*DraftSchema` = saída do LLM (sem IDs); `ai/hydrate.ts` atribui IDs.
- `src/config/` — env validado, `llm-models.ts` (**único lugar com IDs de modelo Claude**), `pricing.ts` (**único lugar com preços**), `quality-presets.ts`.
- `src/costs/` — cálculo puro, orçamento puro, `plan-evaluation.ts` (limite de segundos de IA), ledger, catálogo, câmbio.
- `src/ai/` — `LlmClient` (abstrato), `anthropic/` (**único lugar que importa `@anthropic-ai/sdk`**), prompts versionados em `ai/prompts/`, `runStructuredPrompt`, `LlmCreativePlanner`, `MockCreativePlanner`.
- `src/providers/` — `VideoProvider`/`AudioProvider`, mocks, factories, polling com limite; `audio/elevenlabs-audio-provider.ts` (**único lugar que conhece a ElevenLabs**).
- `src/speech/` — narração pura: texto falado pt-BR (`narration-script.ts`), alinhamento → palavras (`alignment.ts`), legendas com timing (`timed-captions.ts`), `audio-fit.ts`.
- `src/config/tts-models.ts` (**único lugar com IDs de modelo TTS**), `config/voices.ts` (SpeakerProfiles + mapa de vozes), `config/audio-policy.ts` (limites do AudioFit).
- `src/storage/audio-asset-store.ts` — narrações versionadas em `AUDIO_DIR`; rota `src/app/api/audio/...`.
- `src/pipeline/` — estados, guards, contexto de orçamento, `PipelineService`, raiz de composição.
- `src/storage/` — `FilePipelineStore`, `FileCostLedger`, `FileLlmCallLog` (JSON/JSONL atômicos em `DATA_DIR`), `LocalUploadStore` (`UPLOADS_DIR`) e versões em memória.
- `src/render/` — `buildRenderManifest`, `timeline`, `captions`, `scene-strategy`, `composition-props` (puros); `AssetResolver`; `output-paths` (versões vN); `createRenderer` (**único lugar que escolhe o renderer**); `remotion/` (`RemotionRenderer`, servidor de assets; **único lugar do app que importa `@remotion/*`**).
- `remotion/` — composição `TikTokCreative`, componentes, tema (safe areas, tokens), fontes locais. Imports relativos (sem `@/`). Contrato em `remotion/types/props.ts`.
- `src/app/api/renders/[campaignId]/[creativeId]/[renderId]` — player/download por IDs.
- `scripts/plan-real.ts` — validação manual com o Claude real.

## Modelos Claude
| Preset | Modelo | Esforço |
|---|---|---|
| economy | claude-sonnet-5-5 | medium |
| high | claude-sonnet-5-5 | high |
| premium | claude-opus-5-5 | high |
`AUXILIARY_LLM` (claude-haiku-5-5) reservado para tarefas auxiliares; sem roteamento ainda.

## Sistema de custos
- `ProviderPricing { provider, model, unit, priceUsd, updatedAt, isPlaceholder }`. Unidades: `per_second`, `per_1000_characters`, `per_1m_input_tokens`, `per_1m_output_tokens`, `per_1m_cache_write_tokens`, `per_1m_cache_read_tokens`, `per_generation`.
- `CostEstimate` (`kind: "estimate"`) ≠ `GenerationCost` (`kind: "actual"`). Nunca misture.
- Estimativa = **incurred** (rateio REAL do planejamento, do ledger) + **futuro estimado** (vídeo por cena + áudio + render) = `projectedTotal`. A aprovação autoriza o futuro.
- Custo real do Claude: calculado do `usage` da API e do preço do modelo servido; registrado no ledger (`operation: "campaign_plan"`, `llmCallId`) e em `llm-calls.jsonl`. Toda tentativa conta, inclusive as inválidas.
- Dinheiro: USD sem arredondar internamente; BRL com 2 casas na saída; comparações em centavos.
- Preços de vídeo/áudio são **provisórios** (`unassigned-*`).

## Planejamento com Claude
- Fluxo: prompt `campaign-plan@1.0.0` → `output_config.format` (JSON Schema do Zod) → `JSON.parse` → Zod (`validationSchemaFor`) → hydrate → `reviewCampaignPlan` (avalia e ajusta ao preset) → jobs já estimados.
- Retry de validação: `LLM_MAX_VALIDATION_ATTEMPTS` (padrão 2, máx. 3), conversa nova de 1 turno com o erro. `max_tokens`/`refusal` não são retentados. Retry de transporte do SDK: `LLM_MAX_TRANSPORT_RETRIES` (padrão 1).
- Antes de chamar: pior caso do planejamento precisa caber no orçamento da campanha.
- Plano acima do máximo de segundos de IA é ajustado deterministicamente (`fitPlanToPreset`), nunca aceito.

## Planejamento assíncrono (Lote 2)
- UI chama `startPlanning` (cria campanha em `planning` e dispara o planner no processo, sem esperar) e a página faz polling (`router.refresh`).
- `planning` sem execução no processo = **interrompida** (derivado, sem escrita). Retomar é `retryPlanning`, ação explícita com confirmação; nunca automático.
- Cada execução tem `planningRunId`; uma execução substituída só registra custo, não grava plano.
- Falha → `campaign.errorCode` (rate_limited, timeout, invalid_response, not_configured...). UI usa `application/user-errors.ts`.
- `LLM_PROVIDER=anthropic` sem chave → `UnavailablePlanner`: o app abre, só planejar é recusado antes de criar campanha.

## Aprovação e orçamento
- Caminho obrigatório: `planned → cost_estimated → awaiting_approval → (approve) → generating`. Sem atalhos.
- Aprovação vale para **um** `estimateId`; re-estimar invalida.
- Antes de **cada** chamada paga de mídia: `assertCanStartPaidCall` + checagem de orçamento com gasto real.
- `BUDGET_EXCEEDED` → UI oferece Cancelar/Autorizar. `allowOverBudget` = usuário **pode** autorizar, até o total mostrado.
- Regeneração: limite `MAX_ATTEMPTS_PER_SCENE`, custo anterior vira "descartado" mas continua no total.
- Operações por campanha são serializadas (lock). Um processo por `DATA_DIR`.
- UI aprova por criativo via `approveCreative` (requestApproval → approve(estimateId) → `startGeneration`, em background). O diálogo de orçamento só mostra "Autorizar" se `canAuthorizeOverBudget`.

## Renderização (Lote 3)
- Aprovar/retomar/renderizar de novo voltam logo; trabalho roda no processo (`activeJobs`), UI faz polling. Render em 3 fases (lock → sem lock → lock).
- Progresso só com frames reais. `generating`/`rendering` sem execução = interrompido; nada retoma sozinho.
- Saída `outputs/renders/<campanha>/<criativo>/v<N>/` + `manifest.json`; nunca sobrescreve. Render custa R$0 (ledger `rendering`, `simulated: false`).
- Mudou `remotion/`? Reinicie o servidor (bundle em cache por processo). Windows com pasta funda: `RENDER_BROWSER_EXECUTABLE` (D53).
- Licença do Remotion: empresas com mais de 3 pessoas precisam da Company License (D54).

## Narração (Lote 4)
- Narração CONTÍNUA por criativo (D55): uma chamada, um timing. Texto enviado = texto FALADO normalizado; a legenda usa o escrito (D59).
- Estimativa e custo real = caracteres ENVIADOS × preço da API (US$0,05 Flash / US$0,10 Multilingual). `character-cost` (créditos/quota) fica em `providerCharacterCost`, só auditoria — nunca multiplicar pelo preço (D67). Toda tentativa cobrada vai ao ledger.
- Sem retry automático (nem de transporte). Timeout: tentativa falha com aviso de possível cobrança.
- Fala muito mais longa → `audio_review` (aceitar/gerar de novo/cancelar). Nunca cortar fala; nunca regerar sozinho (D61).
- Áudio é asset independente do renderer (`AudioAssetStore`), versionado, servido por IDs.

## Padrões
- TypeScript estrito. `import type` para tipos (lint exige).
- Funções puras para regras; serviços orquestram I/O; injeção de dependência (clock, ids, store, ledger, llm).
- Zod na borda: entrada, saída do LLM, storage, ledger.
- Erros tipados (`LlmError`, `PlanningError`, `CorruptedDataError`...) com `name` próprio. Na camada de UI, identifique erros por `error.name`, não `instanceof` (o runtime é compartilhado entre camadas do bundler do Next). Testes ao lado do código; fixtures em `src/test/`.
- UI: tema claro, zinc + um tom por estado; números monetários com `tabular`; sem libs de UI (primitivos em `components/ui/`). Custos sempre via `presentEstimate`/`presentBudgetDecision`, nunca recalculados no componente.
- Testes de LLM usam `ScriptedLlm` (`src/test/fake-llm.ts`) ou transporte falso do SDK. Testes pagos: `*.integration.test.ts`.
- Comentários e textos de UI em português; identificadores em inglês.

## O que NÃO fazer
- Não gerar cena UGC sem referência aprovada; não chamar Presenter em AI UGC; não combinar fala nativa do clipe com narração real; não escrever fala UGC com experiência inventada.
- Não automatizar a interface web do Google Flow; UGC real só por API oficial, com preço com fonte.
- Não chamar API paga fora do pipeline/planner, nem em testes normais.
- Não escrever IDs de modelo fora de `config/llm-models.ts`, nem preços/cotação fora de `src/config/`.
- Não importar `@anthropic-ai/sdk` fora de `src/ai/anthropic/`.
- Não espalhar prompts; não "consertar" JSON com regex; não aceitar saída inválida.
- Não registrar custo real como simulado; não estimar custo do Claude quando há `usage` real.
- Não criar re-tentativas automáticas pagas nem loops sem limite (inclui fallbacks server-side).
- Não apagar/editar custos (ledger append-only).
- Não logar, serializar ou enviar ao browser a `ANTHROPIC_API_KEY` nem a `GOOGLE_AI_API_KEY`; não commitar `.env*` nem `data/`.
- Não chamar a Krea API fora de `providers/ugc/krea-http.ts`; não enviar/logar `KREA_API_KEY`.
- Não chamar a Gemini API fora de `providers/ugc/google-http.ts`; não habilitar AI UGC REAL só porque a chave existe.
- Não adicionar banco externo, integração TikTok, providers de mídia reais, TTS ou render em nuvem sem instrução do lote.
- Não chamar a ElevenLabs fora de `ElevenLabsAudioProvider`; não espalhar IDs de modelo TTS/voz fora de `config/tts-models.ts`/`config/voices.ts`; não deixar estruturas da ElevenLabs saírem do provider.
- Não logar, serializar ou enviar ao browser a `ELEVENLABS_API_KEY` nem voiceIds; não usar Web Speech/TTS improvisado.
- Não importar `@remotion/*` fora de `src/render/remotion/` (e `scripts/render-setup.ts`); não usar `@/` dentro de `remotion/`.
- Não sobrescrever nem apagar renders; não servir arquivo de render que não esteja registrado no job; não aceitar caminho de render vindo do browser.
- Não apresentar placeholder como vídeo gerado; não sintetizar voz (Web Speech/TTS) nem inventar progresso de render.
- Não aceitar caminhos de arquivo vindos do browser (só IDs gerados: `SAFE_PRODUCT_ID`, `STORED_IMAGE_NAME`, `SAFE_ENTITY_ID`, `RENDER_ID`); não servir arquivos fora de `UPLOADS_DIR`/`RENDERS_DIR`.
- Não colocar regra de negócio/custo em componentes ou Server Actions; não serializar `AppConfig` para o cliente (use `getPublicConfig`).


## Runway (Lote 5)
`npm run video:real -- --image "C:/fotos/produto.jpg"`: dry-run, sem custo/gravações. Só `--confirm` permite UMA geração de 5s via pipeline persistido, com demais providers mock. Nunca executar pago sem instrução. `RUNWAYML_API_SECRET` só no servidor; não logar/serializar. Modelos em `config/video-models.ts`, preços em `config/pricing.ts`. Settings de campanhas antigas não são migrados: criar nova campanha após mudar VIDEO_PROVIDER. Custo estimado por duração comprada 5/10s, task id salvo antes do polling, ledger antes do armazenamento local em VIDEOS_DIR. Sem retry pago. Testes usam `test/runway-fake.ts`. Ver DECISIONS D69–D72.
