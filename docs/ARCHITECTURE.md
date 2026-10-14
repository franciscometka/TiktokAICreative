# Arquitetura

## Camadas

```
src/
  app/          UI (Next.js App Router). Só chama serviços e formata.
  components/   Componentes React de apresentação. Sem regra de negócio.
  domain/       Modelos (schemas Zod) + regras puras pequenas. Não importa nada de fora de domain/ e lib/.
  config/       env (validado), modelos Claude por preset (llm-models.ts), tabela de preços, presets.
  costs/        Cálculo de custo (puro), orçamento (puro), avaliação do plano vs preset (pura),
                ledger de custo real, catálogo de preços, câmbio.
  ai/           LlmClient (abstração), anthropic/ (único uso do SDK), prompts versionados,
                saída estruturada com retry limitado, LlmCreativePlanner, MockCreativePlanner.
  providers/    VideoProvider / AudioProvider (interfaces), mocks, factories, polling.
  pipeline/     Máquinas de estado, guards, contexto de orçamento, PipelineService, raiz de composição.
  render/       RenderManifest (função pura) + Renderer (interface) + MockRenderer.
  storage/      PipelineStore/CostLedger/LlmCallLog em arquivos (JSON + JSONL atômicos) ou memória.
  lib/          Utilitários genéricos: ids, clock, money, result.
  test/         Fixtures compartilhadas de teste.
outputs/        Arquivos gerados (ignorados pelo git).
docs/           SPEC, TASKS, DECISIONS, ARCHITECTURE.
```

Regra de dependência (de fora para dentro):

```
app/components → pipeline → (ai, providers, render, storage, costs) → config → domain → lib
```

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

## Persistência

```
DATA_DIR/
  campaigns/<id>.json   escrita atômica (tmp + fsync + rename)
  jobs/<id>.json        estimativa, aprovação, decisão de orçamento e tentativas dentro do job
  ledger.jsonl          custo real, append-only, fsync por linha
  llm-calls.jsonl       auditoria das chamadas ao LLM
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
              ──▶ rendering ──▶ completed (RenderManifest + outputUri)
completed ──regenerateScene──▶ (checa limite de tentativas e orçamento) ──▶ completed
```

## Estados

Job (`pipeline/states.ts`):

| De | Para |
|---|---|
| planned | cost_estimated, cancelled |
| cost_estimated | cost_estimated, awaiting_approval, cancelled |
| awaiting_approval | generating, cost_estimated, cancelled |
| generating | rendering, budget_exceeded, failed, cancelled, completed* |
| budget_exceeded | generating, cancelled |
| rendering | completed, failed |
| completed | generating (regeneração) |
| failed | cost_estimated, cancelled |
| cancelled | — |

\* só quando uma regeneração falha e o vídeo anterior é mantido.

Campanha: `draft → planning → planned | failed`, `failed → planning`.

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
