# Decisões de arquitetura

Formato curto: **contexto → decisão → consequência**. Decisões novas entram no fim com o próximo número.

---

## Análise do plano original (Lote 0)

Pontos do pedido inicial que foram ajustados ou precisaram de definição:

| # | Ponto do plano | Problema | Resolução |
|---|---|---|---|
| A1 | `GenerationJob` com estados `draft`/`planning` | Um único planejamento (1 chamada de LLM) produz N criativos; os jobs só existem depois do plano | Duas máquinas de estado (D3) |
| A2 | `allowOverBudget` | Ambíguo: pode ser lido como "exceder automaticamente" | Significa só "o usuário PODE autorizar" (D5) |
| A3 | `CostEstimate.llmCost` | Quando a estimativa existe, o planejamento com Claude **já foi pago** | Linha marcada `phase: "planning"` (já incorrido) (D6) |
| A4 | Exemplo `maxCostPerCreativeBrl = 15` + preset Premium R$25–50 | Premium nunca caberia nesse limite | Intencional: Premium exige orçamento maior ou autorização explícita (D16) |
| A5 | `price` em `ProductInput` | Ambíguo (preço de venda × custo) | Renomeado `priceBrl` (preço de venda exibido no vídeo) |
| A6 | Pasta `schemas/` separada de `domain/` | Duplicaria tipos: o schema Zod **é** o modelo | Schemas vivem em `domain/` (D1) |
| A7 | Estimativa usa "provider/modelo planejado" | Se a execução usar outro provider, a estimativa mente | Provider é escolhido pelo preset; o mock simula o preço daquele tier (D7) |
| A8 | Stack inclui Anthropic SDK e Remotion | Não são usados no Lote 0 | Instalados no lote que os usa (D14) |

## Riscos identificados

| Risco | Severidade | Mitigação atual / planejada |
|---|---|---|
| **Store e ledger em memória**: reiniciar o servidor perde jobs e **registros de custo real** | Alta (bloqueante p/ providers pagos) | Persistência local (JSON/SQLite) obrigatória **antes** do primeiro provider pago — TASKS Lote 2 |
| Corrida: duas aprovações simultâneas podem passar no limite da campanha | Média | V1 é single-process; adicionar lock por campanha junto com a persistência |
| Preços de vídeo/áudio são provisórios (`unassigned-*`, `isPlaceholder`) | Média | UI exibe aviso; teste de sanidade falha se faixas saírem da meta |
| Cotação muda entre estimativa e gasto | Baixa | Cada estimativa e cada custo real guardam a cotação usada |
| Provider cobra acima do estimado | Média | Guard de orçamento antes de **cada** chamada com base no gasto real (testado com `billingMultiplier`) |
| Geração longa dentro de request HTTP (polling) | Média | V1 local aceita; mover para worker/fila quando houver provider real |
| LLM devolve plano fora do preset (segundos de IA demais) | Média | Schema + `checkPlanAgainstSettings`; Lote 1 deve re-pedir/ajustar |
| Produto sem imagens → cenas sem IA viram cards de texto | Baixa (qualidade) | Manifest cai para `text_card`; UI deve incentivar upload |
| Render local 1080x1920 é pesado e o "custo 0" ignora tempo de máquina | Baixa | Preço `local/remotion` configurável |
| Conteúdo do usuário (descrição/URL) vai para o prompt | Baixa | Dados enviados como JSON; prompt proíbe inventar alegações |
| Alegações falsas/enganosas em anúncio | Média (compliance TikTok) | Prompt proíbe inventar características/resultados; revisão humana na aprovação |

---

## D1 — Schemas Zod são os modelos de domínio
Contexto: o plano sugeria `schemas/` separado. Decisão: cada entidade é definida uma vez em `src/domain/*.ts` como schema Zod, e o tipo TS vem de `z.infer`. Consequência: zero duplicação; validação na borda (LLM, storage, ledger) usa o mesmo schema.

## D2 — Schemas "Draft" (saída do LLM) sem IDs
Contexto: LLMs inventam/duplicam IDs. Decisão: o LLM produz `*DraftSchema` (sem `id`/`order`); `ai/hydrate.ts` atribui IDs e revalida com o schema completo. As regras (refinements) são compartilhadas entre Draft e completo.

## D3 — Duas máquinas de estado
`Campaign`: `draft → planning → planned | failed`. `GenerationJob` (um por criativo): `planned → cost_estimated → awaiting_approval → generating → rendering → completed`, mais `budget_exceeded`, `failed`, `cancelled`. Tabela em `pipeline/states.ts`; não existe aresta de `planned`/`cost_estimated` para `generating`.

## D4 — Aprovação vinculada a UMA estimativa
`Approval.estimateId` precisa ser igual a `job.estimate.id`. Recalcular a estimativa remove a aprovação. `approve()` com ID antigo lança `StaleEstimateError`. Evita "aprovei R$5, gerou R$12".

## D5 — `allowOverBudget` é permissão para PEDIR, não para exceder
Exceder nunca é automático. `checkBudget` retorna `BUDGET_EXCEEDED` com `currentCostBrl`, `additionalEstimatedCostBrl`, `newEstimatedTotalBrl`, `budgetBrl`, `canAuthorizeOverBudget`. Se o usuário autorizar, a `OverBudgetAuthorization` cobre **somente até o novo total mostrado** — passar dele exige nova decisão. Com `allowOverBudget=false`, autorizar lança `OverBudgetNotAllowedError`.

## D6 — Custo do planejamento fica no nível da campanha
O ledger registra o LLM com `jobId = null`. Na estimativa do criativo, o rateio aparece com `phase: "planning"` (já incorrido). Checagem por criativo = rateio + gasto real + adicional; por campanha = planejamento real + compromissos dos outros jobs + gasto deste job + adicional (`pipeline/budget-context.ts`).

## D7 — Provider é resolvido a partir do preço do tier
Os presets apontam para entradas do catálogo (`provider/model`). As factories (`providers/*/index.ts`) recebem esse `ProviderPricing`. Em V1 a factory `mock` devolve um mock que **simula o preço do tier**, então estimativa e custo (simulado) usam a mesma tabela.

## D8 — Preços provisórios explícitos
Vídeo e áudio usam `provider: "unassigned-video" | "unassigned-audio"` com `isPlaceholder: true`, escolhidos para caber nas metas iniciais. O LLM usa o preço oficial do `claude-opus-5-5` (US$4/US$20 por 1M tokens, tabela de 2026-10-06). `CostEstimate.containsPlaceholderPrices` propaga o aviso para a UI.

## D9 — Ledger append-only; "descartado" é derivado
`CostLedger` só tem `record` e `list`; registros são congelados. Se um custo foi descartado é derivado do estado das tentativas do job (`active = false`), não de mutação no ledger. Total real sempre inclui tentativas descartadas e falhas faturadas.

## D10 — Aritmética monetária
Cálculo interno em USD (`number`) sem arredondar; USD arredondado a 6 casas e BRL a 2 só na saída. Comparações de orçamento em **centavos inteiros** (`toCents`).

## D11 — Saída estruturada do LLM: JSON.parse + Zod, retry limitado
Sem regex para "consertar" JSON. Resposta inválida → reenvia uma vez (default 2 tentativas, máximo 3) com os erros de validação. `max_tokens` e `refusal` não são retentados. O uso de tokens de **todas** as tentativas é devolvido para ser registrado. No Lote 1, a chamada deve usar structured outputs da API, mantendo a validação Zod do nosso lado.

## D12 — Mídia: nenhuma re-tentativa automática
Falha de provider → tentativa registrada (com custo, se faturada) → job `failed`. Retomar exige `estimateCost` + nova aprovação. Polling tem `maxPolls` rígido.

## D13 — Limite de tentativas por cena
`MAX_ATTEMPTS_PER_SCENE` (default 3, máx 10) inclui a primeira geração. Vale também para o áudio. Impede loops de regeneração.

## D14 — Dependências instaladas quando usadas
`@anthropic-ai/sdk` entra no Lote 1; `remotion`/`@remotion/*` no lote de renderização. Evita dependências mortas e versões escolhidas cedo demais. A interface `LlmClient` e `Renderer` já existem.

## D15 — Planejamento checa o orçamento da campanha
Antes de chamar o planner, o custo estimado do planejamento é comparado com `maxCostPerCampaignBrl` (`PlanningBudgetError`). O planejamento não exige aprovação (é barato e é uma ação explícita do usuário), mas é contabilizado.

## D16 — Orçamento default R$20/criativo, R$100/campanha, sem exceder
Premium (meta R$25–50) estoura o default de propósito: escolher Premium exige subir o limite ou autorizar explicitamente.

## D17 — Regeneração que falha mantém o vídeo anterior
`regenerateScene` com falha registra a tentativa (e o custo, se faturado) e volta o job para `completed` com `error` preenchido; o vídeo final não muda. Por isso existe a aresta `generating → completed`.

## D18 — Modelo LLM default: `claude-opus-5-5` em todos os presets
Trocar para um modelo mais barato no preset Econômico é decisão de produto do usuário (custo × qualidade); basta mudar `llm` no preset e adicionar o preço ao catálogo.

## D19 — Estrutura de pastas (diferenças da proposta)
- `schemas/` → dentro de `domain/` (D1).
- `remotion/` ainda não existe (D14); o contrato é `render/renderer.ts` + `RenderManifest`.
- `lib/` contém só utilitários genéricos (ids, clock, money, result).
- `src/test/fixtures.ts` concentra fixtures; testes ficam ao lado do código (`*.test.ts`).
- `pipeline/create-pipeline-service.ts` é a raiz de composição (único lugar que escolhe implementações).

---

# Lote 1 — Planejamento real com Claude

## D20 — Persistência local: JSON + JSONL com escrita atômica (não SQLite)
Contexto: antes de chamadas pagas, campanhas, jobs, estimativas, aprovações, ledger e uso de tokens precisam sobreviver a restart. Opções: SQLite (`node:sqlite` ainda experimental no Node 24; `better-sqlite3` exige build nativo no Windows) ou arquivos.
Decisão: arquivos locais em `DATA_DIR` (padrão `data/`, fora do git):
- `campaigns/<id>.json` e `jobs/<id>.json` — um arquivo por entidade, **escrita atômica** (arquivo temporário no mesmo diretório → `fsync` → `rename`, com retry curto para `EPERM/EBUSY` do Windows). Estimativa, aprovação, decisão de orçamento e tentativas ficam dentro do job.
- `ledger.jsonl` e `llm-calls.jsonl` — append-only, uma linha por registro, `fsync` por append, appends serializados no processo.
- Recuperação: temporários órfãos são apagados; linha final sem `\n` (append nunca confirmado) é ignorada na leitura e truncada antes do próximo append; linha completa inválida ou ID duplicado → `CorruptedDataError` (nunca ignorado em silêncio). Tudo validado com Zod ao gravar e ao ler.
Consequência: zero dependência nova, atômico por arquivo, recuperável. Limite: sem transação entre arquivos (ex.: custo gravado e job não salvo se o processo cair no meio) e um único processo por `DATA_DIR`. Aceitável para uso local single-user; migrar para SQLite quando houver UI concorrente/background worker.

## D21 — Modelo Claude por preset, centralizado
`config/llm-models.ts` é o ÚNICO lugar com IDs de modelo: economy → `claude-sonnet-5-5` (esforço medium), high → `claude-sonnet-5-5` (high), premium → `claude-opus-5-5` (high). `AUXILIARY_LLM` (`claude-haiku-5-5`) fica reservado para tarefas auxiliares de alto volume — sem roteamento por enquanto. O preço de cada modelo (entrada, saída, escrita e leitura de cache) está em `config/pricing.ts`.

## D22 — Saída estruturada nativa + validação própria
A requisição usa `output_config.format` (JSON Schema gerado do Zod pelo helper oficial `zodOutputFormat`, enviando só o schema). O parse e a validação são SEMPRE nossos: `JSON.parse` → Zod (`validationSchemaFor(input)`, que inclui regras impossíveis em JSON Schema: soma de durações, quantidade exata de criativos, estilos permitidos, nº mínimo de hooks) → hydrate de IDs. Sem regex, sem aceitar resposta inválida.

## D23 — Política de retry
- **Validação** (`LLM_MAX_VALIDATION_ATTEMPTS`, padrão 2, máx. 3): saída vazia/JSON inválido/schema violado → nova chamada de UM turno (sem editar histórico) com os erros e a resposta rejeitada como referência. `max_tokens` e `refusal` não são retentados.
- **Transporte** (`LLM_MAX_TRANSPORT_RETRIES`, padrão 1, máx. 2): retries do próprio SDK para 429/5xx/conexão.
- Server-side `fallbacks` da Anthropic (re-executar recusa em outro modelo) **não** está habilitado: seria uma chamada paga automática a outro modelo. Pode virar opt-in explícito no futuro.
- Toda tentativa, válida ou não, é registrada (D24).

## D24 — Custo real do Claude
Cada chamada gera um `LlmCallRecord` (`llm-calls.jsonl`: modelo pedido e servido, request id, tokens de entrada/saída/escrita e leitura de cache, stop reason, desfecho, duração, custo USD/BRL, cotação) e linhas no ledger (`operation: "campaign_plan"`, `llmCallId`, uma linha por tarifa usada), calculadas a partir do `usage` real da API e do preço do modelo que REALMENTE respondeu. Cache: escrita = 1,25× entrada (TTL 5 min), leitura conforme tabela. Chamadas reais nunca são marcadas como simuladas; o mock marca `simulated: true`.

## D25 — Estimativa: incorrido × futuro
`CostEstimate` agora separa `incurred` (rateio REAL do planejamento, vindo do ledger, com os IDs dos registros) de custo futuro estimado (vídeo por cena + áudio + render) e `projectedTotal`. A aprovação autoriza o **futuro**; o incorrido não volta se a geração for cancelada.

## D26 — Estratégia híbrida IA/assets
Cada cena declara `visualSource` (`generated_video`, `product_image`, `text_card`, `simple_background`, `screenshot`, `existing_asset`) e `motion` (`none`, `ken_burns`, `pan`, `zoom_in`, `crop`). Regra de domínio: `requiresGeneratedVideo ⇔ visualSource = "generated_video"`. O prompt orienta usar vídeo gerado só onde há movimento real que fotos não entregam.

## D27 — Limite de segundos de IA: validação + ajuste determinístico
Não confiamos no LLM. `evaluatePlanAgainstPreset()` (pura) recalcula segundos de IA, compara com o preset (acima do máximo = erro; abaixo = aviso), checa duração final e estima o custo futuro. Se exceder, `fitPlanToPreset()` ajusta SEM nova chamada paga: percorre cenas geradas da última para a primeira (o primeiro clipe, normalmente o gancho, é protegido), reduz segundos se o clipe continuar com ≥2s, senão troca por imagem do produto com movimento. A campanha guarda avaliação original, ajustes e avaliação final (`campaign.reviews`). Nenhum plano acima do máximo segue adiante.

## D28 — Pior caso do planejamento checado antes da chamada
Antes de chamar o Claude: `tentativas × (entrada estimada + max_tokens de saída)` ao preço do modelo do preset deve caber no orçamento da campanha (`PlanningBudgetError`).

## D29 — Segurança da API key
A chave é lida só por `readAnthropicApiKey()` dentro da fábrica do cliente (servidor); não entra em `AppConfig`, logs, respostas ou componentes. O cliente guarda o SDK em campo privado (`#`), e mensagens de erro passam por um redator que remove a chave e qualquer padrão `sk-ant-…`.

## D30 — Lock por campanha
Operações que mudam estado de job (estimar, aprovar, gerar, regenerar, resolver orçamento, cancelar) são serializadas por campanha (`KeyedMutex`), eliminando a corrida entre aprovações simultâneas no mesmo processo.
