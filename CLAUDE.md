# CLAUDE.md — TikTok AI Creative Factory

Guia para futuras sessões do Claude neste repositório. Leia também `docs/DECISIONS.md` antes de mudar arquitetura.

## Objetivo
Transformar dados de um produto em vários criativos verticais (MP4 1080x1920) para TikTok Shop:
produto → análise/hooks/conceitos/roteiro/cenas (Claude) → validação + ajuste ao preset → **estimativa de custo** → **aprovação humana** → vídeo (provider) → áudio → Remotion → MP4.
Custo é preocupação central; nada pago de mídia acontece sem aprovação explícita.

## Estado atual
- Lotes 0, 1 e 2 concluídos. Lote 2 = experiência `/create` → `/campaigns/[id]` (planejar, revisar, custo, aprovar).
- Planejamento: `LLM_PROVIDER=mock` (padrão, sem custo) ou `anthropic` (Claude real, pago).
- Vídeo, áudio e renderer continuam **mocks** (aprovação roda em MODO DE TESTE). Remotion real = Lote 3.
- Prompt `campaign-plan@1.0.0` validado com o Claude real em 2026-10-14 (economy, 1 criativo, válido na 1ª tentativa, US$0,0414). Antes de mídia real, aplicar as regras de conteúdo da D42 (`campaign-plan@1.0.1`).
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
- `src/providers/` — `VideoProvider`/`AudioProvider`, mocks, factories, polling com limite.
- `src/pipeline/` — estados, guards, contexto de orçamento, `PipelineService`, raiz de composição.
- `src/storage/` — `FilePipelineStore`, `FileCostLedger`, `FileLlmCallLog` (JSON/JSONL atômicos em `DATA_DIR`), `LocalUploadStore` (`UPLOADS_DIR`) e versões em memória.
- `src/render/` — `buildRenderManifest` (puro), `MockRenderer`.
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
- UI aprova por criativo via `approveCreative` (requestApproval → approve(estimateId) → generate). O diálogo de orçamento só mostra "Autorizar" se `canAuthorizeOverBudget`.

## Padrões
- TypeScript estrito. `import type` para tipos (lint exige).
- Funções puras para regras; serviços orquestram I/O; injeção de dependência (clock, ids, store, ledger, llm).
- Zod na borda: entrada, saída do LLM, storage, ledger.
- Erros tipados (`LlmError`, `PlanningError`, `CorruptedDataError`...) com `name` próprio. Na camada de UI, identifique erros por `error.name`, não `instanceof` (o runtime é compartilhado entre camadas do bundler do Next). Testes ao lado do código; fixtures em `src/test/`.
- UI: tema claro, zinc + um tom por estado; números monetários com `tabular`; sem libs de UI (primitivos em `components/ui/`). Custos sempre via `presentEstimate`/`presentBudgetDecision`, nunca recalculados no componente.
- Testes de LLM usam `ScriptedLlm` (`src/test/fake-llm.ts`) ou transporte falso do SDK. Testes pagos: `*.integration.test.ts`.
- Comentários e textos de UI em português; identificadores em inglês.

## O que NÃO fazer
- Não chamar API paga fora do pipeline/planner, nem em testes normais.
- Não escrever IDs de modelo fora de `config/llm-models.ts`, nem preços/cotação fora de `src/config/`.
- Não importar `@anthropic-ai/sdk` fora de `src/ai/anthropic/`.
- Não espalhar prompts; não "consertar" JSON com regex; não aceitar saída inválida.
- Não registrar custo real como simulado; não estimar custo do Claude quando há `usage` real.
- Não criar re-tentativas automáticas pagas nem loops sem limite (inclui fallbacks server-side).
- Não apagar/editar custos (ledger append-only).
- Não logar, serializar ou enviar ao browser a `ANTHROPIC_API_KEY`; não commitar `.env*` nem `data/`.
- Não adicionar banco externo, integração TikTok, providers de mídia reais ou Remotion real sem instrução do lote.
- Não aceitar caminhos de arquivo vindos do browser (só IDs gerados: `SAFE_PRODUCT_ID`, `STORED_IMAGE_NAME`); não servir arquivos fora de `UPLOADS_DIR`.
- Não colocar regra de negócio/custo em componentes ou Server Actions; não serializar `AppConfig` para o cliente (use `getPublicConfig`).
