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

---

# Lote 2 — Interface de criação

## D31 — Camada `application/` entre a UI e o pipeline
Contexto: as telas precisam de formulário validado, view model serializável, custos formatados e erros legíveis, sem regra de negócio em componentes nem em Server Actions. Decisão: `src/application/` concentra os casos de uso da UI (`campaign-actions.ts`, funções que recebem `{ service, uploads }`), a validação do formulário (`campaign-form.ts`), o view model (`campaign-view.ts`), a apresentação de custos (`cost-presentation.ts`) e os erros de usuário (`user-errors.ts`). `app/actions.ts` só valida o formato dos argumentos e delega. Consequência: tudo testável sem Next; componentes recebem dados prontos e não recalculam custo.

## D32 — Planejamento em background no próprio processo (sem fila)
Contexto: uma chamada ao Claude pode levar minutos; não queremos uma request aberta esse tempo, nem Redis/BullMQ. Decisão: `PipelineService.startPlanning` valida, persiste a campanha em `planning` e dispara o planner SEM esperar, guardando a promessa num `Map` do processo (`activePlanning`). A página faz polling com `router.refresh()`. `planCampaign` continua existindo (espera o fim) para scripts e testes. Consequência: simples e correto para uso local single-process. NÃO é fila durável: se o processo cair, nada retoma sozinho (D33).

## D33 — Interrupção derivada e retomada explícita
Contexto: com o processo reiniciado, uma campanha pode ficar em `planning` para sempre; e a chamada ao Claude que estava em curso pode ter sido cobrada sem que o `usage` chegasse. Decisão: "interrompida" é DERIVADO na leitura (`planning` && não está em `activePlanning`) — ler o status nunca escreve nem chama nada. Planejar de novo é `retryPlanning`, uma ação do usuário com confirmação que avisa do possível custo não registrado; ela marca `failed/interrupted`, checa pior caso + custo já gasto contra o orçamento e inicia uma nova execução. Consequência: nenhuma chamada paga é repetida silenciosamente.

## D34 — `planningRunId`: execução substituída não grava plano
Contexto: em `next dev` (hot reload) ou em restart, uma execução antiga pode terminar depois de o usuário retomar. Decisão: cada execução recebe `planningRunId`; ao terminar, ela registra o custo das chamadas (sempre) e só grava o plano se a campanha ainda estiver em `planning` com o mesmo `runId`. O runtime do processo fica em `globalThis` para sobreviver ao hot reload. Consequência: o custo real nunca se perde e o resultado mais recente não é sobrescrito.

## D35 — Código de erro tipado na campanha
Contexto: a UI precisa diferenciar rate limit, timeout, resposta inválida, falta de chave etc. sem interpretar mensagens. Decisão: `Campaign.errorCode` (`CAMPAIGN_ERROR_CODES`) é preenchido por `planningErrorCode()`; `PlanningError` carrega o `llmErrorKind`. A mensagem técnica fica em `campaign.error`/log e aparece só em "Detalhes técnicos". `LLM_PROVIDER=anthropic` sem chave usa `UnavailablePlanner`: o app abre e mostra campanhas; criar/replanejar é recusado ANTES de qualquer escrita.

## D36 — Erros identificados por `name` na camada de UI
Contexto: no Next, o runtime em `globalThis` é compartilhado entre camadas do bundler (páginas/Server Actions × route handlers), e cada camada pode carregar sua própria cópia de um módulo; `instanceof` falha entre cópias (visto no upload). Decisão: `toUserError` identifica erros por `error.name` (todas as classes definem `name`). Dentro do pipeline o `instanceof` continua válido (planner e serviço vêm da mesma composição).

## D37 — Uploads locais: confiança zero no browser
Decisão: `LocalUploadStore` grava em `UPLOADS_DIR/<productId>/img_<uuid>.<ext>`; o tipo é detectado pela assinatura dos bytes (JPEG/PNG/WebP) e precisa bater com o MIME declarado; limite de 8 MB e 6 imagens por produto (serializado por produto). `productId` e nome do arquivo são validados por regex e o caminho resolvido precisa ficar dentro da raiz. O formulário envia só IDs de imagem; as URIs do `ProductInput` vêm do store. A leitura é servida por `GET /api/uploads/<productId>/<arquivo>` com `nosniff` e CSP restritiva. O POST confere a origem (anti-CSRF). Upload via route handler (não Server Action) para não depender do limite de 1 MB do corpo das actions.

## D38 — AUTO = todos os formatos, sem mudar o prompt
Contexto: "AUTO" deixa o Claude escolher os ângulos. Decisão: AUTO envia todos os `CREATIVE_STYLES` em `styles` e marca `styleSelection: "auto"` no pedido; o prompt `campaign-plan@1.0.0` já instrui a escolher formatos adequados (e a evitar antes/depois sem mudança visível). Não alteramos o prompt antes da validação real (Etapa 0 pendente).

## D39 — Aprovação por criativo e modo de teste
Decisão: cada criativo é aprovado separadamente (a aprovação vale para um `estimateId`, D4). O botão mostra o custo FUTURO ("Gerar por aproximadamente R$X"); o total projetado aparece ao lado. Com providers de mídia mock, a interface mostra "MODO DE TESTE — nenhuma mídia real será gerada ou cobrada" e, ao concluir, deixa claro que nenhum MP4 foi gerado. A geração mock roda dentro da Server Action; providers reais exigirão execução em background (Lote 5).

## D40 — Visual
Tema claro (o app era só escuro), Inter via `next/font`, escala zinc com um tom por estado (azul = vídeo IA/andamento, verde = imagem do produto/concluído, âmbar = provisório/atenção, vermelho = erro). Sem biblioteca de UI: primitivos em `components/ui/` (Button, Badge, Panel, Notice, InfoTip, Dialog nativo). Dark mode fica para depois.

## D41 — Atraso opcional do planner mock
`MOCK_PLANNER_DELAY_MS` (padrão 0, só com `LLM_PROVIDER=mock`) simula a demora do Claude para exercitar a tela de processamento, o polling e a recuperação após restart sem custo.

## D42 — Validação real do `campaign-plan@1.0.0` e duas regras de conteúdo
Contexto: em 2026-10-14 foi feita UMA validação real (`npm run plan:real -- --confirm`, preset economy, 1 criativo). Resultado: `claude-sonnet-5-5` (esforço medium), válido na 1ª tentativa; 613 tokens de entrada, 2.801 de saída e 4.867 de escrita de cache; 25,5s; custo real US$0,0414 (≈ R$0,23). Plano: 24s finais, 9s de vídeo IA (permitido 8–12s), nenhum ajuste de `fitPlanToPreset`; futuro estimado R$4,05, total projetado R$4,28, com preços de mídia ainda provisórios. Estruturalmente o prompt está correto. A leitura do conteúdo mostrou dois riscos de honestidade que o prompt atual não cobre explicitamente.
Decisão: duas regras de conteúdo passam a fazer parte da especificação (SPEC, "Regras de conteúdo") e devem entrar no prompt como `campaign-plan@1.0.1` ANTES de qualquer geração de mídia real:
1. **Sem experiência inventada**: o narrador/ator não afirma uso pessoal, depoimento, teste realizado ou resultado vivido ("testei por uma semana", "uso todo dia", "minha água ficou gelada até a noite") que não esteja nas informações fornecidas.
2. **Sem falsa prova visual**: alegações temporais ou características informadas pelo vendedor (ex.: "gelado por 24h", "não vaza") são apresentadas como informação do produto (texto/narração), nunca encenadas como se a cena comprovasse o fato (ex.: relógio passando de 8h para 20h com a bebida ainda gelada, timelapse de "24 horas depois", teste de vazamento demonstrado como prova).
Consequência: o prompt NÃO foi alterado neste commit (sem nova chamada à Anthropic). A `1.0.1` será uma correção mínima e documentada; uma nova validação real só com autorização. **Atualização (Lote 4): `campaign-plan@1.0.1` criada e ativa — ver D65.**

## D43 — Remotion local, isolado e com versão fixa
Decisão: renderização real com Remotion **4.0.531** (`remotion`, `@remotion/bundler`, `@remotion/renderer`, versões exatas no `package.json`), rodando na máquina do usuário. A composição vive em `remotion/` (imports relativos, sem `@/`, para o bundler do Remotion) e o único código do app que importa `@remotion/*` é `src/render/remotion/` (+ `scripts/render-setup.ts`). `createRenderer` (`render/create-renderer.ts`) é o ÚNICO ponto que escolhe `RENDERER=mock|remotion`; `LazyRemotionRenderer` só importa o Remotion no primeiro render, então testes e `RENDERER=mock` nem carregam o pacote. No Next, os pacotes do Remotion ficam em `serverExternalPackages`. Fora de escopo: Lambda, cloud render, render farm, fila externa.

## D44 — Contrato de props serializável; timing puro em frames
Decisão: `buildCompositionProps` (`render/composition-props.ts`, puro) transforma `RenderManifest` + assets resolvidos em `CreativeProps` (`remotion/types/props.ts`): tudo já em frames e com URLs prontas; a composição só desenha. Frames vêm de `render/timeline.ts`: a posição de cada cena sai da soma ACUMULADA das durações em ms inteiros, arredondada uma única vez (nunca somamos frames arredondados); a última cena termina exatamente no último frame. A duração da composição vem de `calculateMetadata` a partir das props (nada fixo no código). `COMPOSITION_VERSION` e `RENDERER_VERSION` vão para o `manifest.json` de cada render.

## D45 — VisualSource → estratégia visual (sem enum paralelo)
Decisão: `sceneStrategy` (`render/scene-strategy.ts`) mapeia os `VisualSource` do domínio para `SceneAssetKind` (`generated_video | product_image | text_card`). `screenshot`/`existing_asset` ainda não têm upload: usam a imagem do produto (ou card de texto) com aviso `asset_not_provided`. Enquanto o provider de vídeo é mock, a cena de vídeo IA vira **placeholder explícito**: selo "MOCK · VÍDEO IA" + hachura diagonal sobre a foto escurecida (nunca parece vídeo gerado) e aviso `generated_video_placeholder`. A descrição técnica da cena só aparece com `RENDER_DEBUG=true`.

## D46 — Assets: raízes autorizadas e servidor efêmero
Decisão: `AssetResolver` só aceita URIs relativas dentro das raízes permitidas (`UPLOADS_DIR`), com extensão de imagem e conteúdo conferido pela assinatura; recusa caminho absoluto, UNC, esquema (`http:`, `file:`, `C:`), caractere nulo e traversal com `AssetSecurityError` (nunca rebaixado a aviso). `mock://` vira placeholder sem tocar no disco; arquivo autorizado mas ausente vira aviso `asset_file_missing` + card de texto. O Chrome do Remotion baixa as imagens de um servidor HTTP efêmero em `127.0.0.1` (porta aleatória) que só serve tokens aleatórios mapeados para os arquivos já autorizados; nada é copiado para o bundle. O `manifest.json` gravado troca as URLs efêmeras por `asset:<uri relativa>` (sem caminho absoluto, sem segredo).

## D47 — Saída versionada; nunca sobrescreve
Decisão: `<RENDERS_DIR>/<campaignId>/<creativeId>/v<N>/{final.mp4, manifest.json}`. A versão é reservada com `mkdir` não recursivo (atômico: falha se já existir), o vídeo é escrito em `final.partial.mp4` e renomeado só no fim; em erro, o parcial e a pasta vazia são removidos. Os IDs são validados por regex antes de virar caminho. Se o processo morrer no meio, a pasta da versão pode ficar vazia; a tentativa seguinte usa a próxima versão (nada é sobrescrito nem apagado).

## D48 — Render em segundo plano, sem segurar lock; interrupção explícita
Decisão: aprovar (`startGeneration`), resolver orçamento (`startBudgetResolution`) e renderizar de novo (`startRerender`) voltam logo; o trabalho roda no processo (`activeJobs`) e a página faz polling (`AutoRefresh`). Isso substitui a nota da D39 (geração dentro da Server Action). O render tem 3 fases: (lock) monta o manifest e cria o `RenderRecord` `rendering` → (sem lock) `renderer.render()` → (lock) grava `completed`/`failed`, saída, tempo, avisos e o custo local. Progresso = frames REAIS informados pelo Remotion, só em memória; antes do primeiro frame a barra é indeterminada (sem porcentagem inventada). Job em `generating`/`rendering` sem execução no processo = **interrompido** (derivado; badge "Interrompido"); nada recomeça sozinho: "Renderizar novamente" é ação explícita com confirmação. Novas arestas: `completed → rendering` e `failed → rendering`, só com toda a mídia ativa (`mediaComplete`); renderizar de novo NUNCA gera vídeo/áudio de novo. Uma ação por job por vez (`JobInProgressError`). Log server-side por render: `[render] job=… campaign=… creative=… render=vN frames=… duracao=… tempo=… saida=… avisos=…`.

## D49 — Player e download por IDs
Decisão: `GET /api/renders/<campaignId>/<creativeId>/<renderId>` (e `?download=1`). `resolveRenderFile` só entrega versões `completed`, não-mock e registradas no job; o caminho é recalculado por `renderDir` (IDs validados, contido na pasta de renders) — nunca vem do browser. Suporta `Range` (206/416) para o `<video>`, com `Content-Type: video/mp4`, `nosniff` e `Content-Disposition` inline/attachment.

## D50 — Layout do criativo
Decisão: tokens em `remotion/styles/theme.ts`. Safe areas (px no canvas 1080x1920): topo 200, base 440, esquerda 72, direita 180 (coluna de botões); hook, textos, legenda e CTA ficam dentro da caixa útil (testado). Fonte Inter via `@fontsource/inter` (arquivo local, OFL): render offline e determinístico. Hook nos primeiros 1,5–3s; CTA nos últimos 3,5s (ou na última cena); nome e preço aparecem UMA vez, no CTA, com preço via `formatBrl` ("R$ 79,90"). Legenda: trechos determinísticos da narração (`render/captions.ts`, ≤30 caracteres/6 palavras, ≥0,6s), sem karaokê (não há timing por palavra), sobre faixa escura translúcida, cortada quando o CTA entra. Imagem: `cover` se a proporção for ≤ 0,7, senão `contain` sobre fundo desfocado (sem distorção), com movimento leve. Transições cut-first; fade/slide/zoom sobrepõem 8 frames sem mudar a duração total. Sem logo do TikTok, UI falsa ou carrinho clicável.

## D51 — Encoding
Decisão: H.264, `yuv420p` com `colorSpace: "bt709"` (range limitado "tv"; o padrão do Remotion sai `yuvj420p` full-range, menos compatível), CRF 20, `muted: true` — o MP4 não tem trilha de áudio enquanto a narração for mock (aviso `audio_unavailable` sempre). Nenhuma voz é sintetizada (sem Web Speech/TTS improvisado); áudio real é o Lote 4.

## D52 — Custo do render
Decisão: render local custa R$0,00 (preço `local/remotion` = 0 em `config/pricing.ts`). Cada render real registra uma linha `rendering` no ledger com `simulated: false` e valor 0, para auditoria; não é custo de provider e não muda a estimativa nem o orçamento.

## D53 — Windows: caminho longo do Chrome; cache do bundle
Contexto: no Windows, o caminho do `chrome-headless-shell.exe` dentro de `node_modules/.remotion/` passa de 260 caracteres quando o projeto está numa pasta funda, e o Chrome não abre (`ENOENT`). Decisão: `RENDER_BROWSER_EXECUTABLE` aponta para uma cópia em caminho curto (opcional; vazio = o Chrome baixado por `npm run render:setup`). O bundle do Remotion é feito uma vez por processo e fica em memória: mudanças em `remotion/` exigem reiniciar o servidor.

## D54 — Licença do Remotion
O Remotion é gratuito para pessoas físicas e empresas com até 3 pessoas; acima disso exige **Company License** (remotion.pro). `REMOTION_LICENSE_KEY` (opcional, lida só no servidor por `readRemotionLicenseKey`) é repassada ao `renderMedia`; sem chave, nada é enviado. Verificar a licença antes do uso comercial pela empresa.

---

# Lote 4 — Narração real (ElevenLabs)

## D55 — Narração CONTÍNUA por criativo (não por cena)
Contexto: a narração pode ser gerada cena a cena ou de uma vez para o criativo inteiro.
Avaliação:
| Critério | Por cena | Contínua (escolhida) |
|---|---|---|
| Naturalidade | prosódia reinicia a cada cena, emendas audíveis | entonação e ritmo de uma fala só |
| Sincronização | precisa colar N arquivos e alinhar cada um | um arquivo, um timing; janelas por cena derivadas das palavras |
| Regeneração | pode refazer só uma cena | refaz tudo (narração de 20–40s) |
| Custo | igual em caracteres; N requisições | igual em caracteres; 1 requisição |
| Robustez | N pontos de falha, estados parciais | 1 chamada, 1 desfecho; sem estado parcial |
| Avatar / lip sync | N cortes de áudio | uma faixa contínua, ideal para lip sync |
Decisão: uma chamada por criativo com o texto das cenas na ordem (`buildNarrationScript`). As janelas de fala de cada cena (`timing.scenes`) são derivadas do alinhamento e ficam salvas para uso futuro. Consequência: regenerar custa a narração inteira (≈ US$0,01–0,05 por criativo), aceitável pelo ganho de naturalidade e simplicidade.

## D56 — ElevenLabs isolado em um provider, sem SDK
Decisão: `ElevenLabsAudioProvider` (`providers/audio/elevenlabs-audio-provider.ts`) implementa `AudioProvider` e é o ÚNICO lugar que conhece a ElevenLabs: `POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128`, header `xi-api-key`, corpo, formato de resposta, headers (`request-id`, `character-cost`) e erros. Usa `fetch` direto (sem SDK): nenhuma dependência nova e controle total de retry (zero). Para fora sai só `AudioResult` em tipos internos (bytes, `CharacterTiming`, request id, caracteres enviados, consumo bruto do provider). `AUDIO_PROVIDER=mock|elevenlabs`; a chave é lida só por `readElevenLabsApiKey()` na raiz de composição, fica em campo privado (`#apiKey`) e é redigida de qualquer mensagem de erro. Sem chave, a factory falha com erro claro na geração, ANTES de qualquer chamada paga (nem vídeo).

## D57 — Modelos de TTS por preset e preço oficial
`config/tts-models.ts` é o único lugar com IDs: economy → `eleven_flash_v2_5`; high/premium → `eleven_multilingual_v2`. `language_code: "pt"` só vai para o Flash (o Multilingual v2 não aceita e detecta pelo texto). Preço da API (tabela vigente, elevenlabs.io/pricing/api, 2026-10-14): Flash/Turbo **US$0,05** e Multilingual v2 **US$0,10** por 1.000 caracteres, `isPlaceholder: false` (fonte e data em `pricing.ts`). Os placeholders `unassigned-audio` saíram da tabela.

## D58 — SpeakerProfile independente da voz do provider
`SpeakerProfile` (domain/audio.ts) descreve a voz do PRODUTO (nome amigável, idioma, gênero, idade, tom), sem voiceId. `config/voices.ts` lista os perfis pt-BR (Clara, Bia, Rafael, Lucas) e, separadamente, o mapa perfil → voz ElevenLabs (vozes padrão multilíngues; trocar por vozes pt-BR nativas da Voice Library muda só essa tabela). O pedido guarda `speakerProfileId` (opcional; padrão Clara). Futuro avatar UGC = `PresenterProfile` (aparência) + `SpeakerProfile` (voz), sem mudar este tipo. Sem voice cloning.

## D59 — Texto falado normalizado (pt-BR) ligado ao texto escrito
Decisão: `speech/narration-script.ts` converte o texto escrito em texto falado — dinheiro ("R$ 79,90" → "setenta e nove reais e noventa centavos"), números (com gênero do substantivo seguinte: "duas horas"), unidades (ml, kg, h…), porcentagem e decimais — guardando, para cada token escrito, o intervalo correspondente no texto falado. O TTS recebe o texto falado (não dependemos da normalização do provider, que no Flash é limitada); a legenda mostra o texto escrito. A estimativa de custo usa os caracteres do texto FALADO (é o que é cobrado). Determinístico.

## D60 — Timing real → palavras → legendas
Decisão: o alinhamento por caractere vira `CharacterTiming` (interno) no provider; `wordsFromAlignment` produz `TimedWord` (palavra escrita + início/fim reais + cena), monotônico; `captionsFromWords` agrupa com os limites do Lote 3 (≤30 caracteres, ≤6 palavras, quebra na pontuação e na troca de cena) e cada trecho começa quando sua primeira palavra é dita. O manifest marca `captionSource: "alignment"`. Se o alinhamento não bater com o texto enviado (ou não vier), `AlignmentMismatchError` → legendas estimadas do Lote 3 + aviso `captions_estimated`; nunca inventamos timing.

## D61 — AudioFit e revisão explícita
`evaluateAudioFit` compara a duração planejada com o fim REAL da fala (`config/audio-policy.ts`): |diferença| ≤ 0,5s → `fits`; fala mais curta → `too_short` (o vídeo segue o plano); mais longa até max(2s, 10%) → `extend` (a última cena/CTA ganha o excedente + 0,4s de respiro, localmente, sem nova chamada); mais longa que isso → `review`: o job vai para o novo estado `audio_review` e espera o usuário — aceitar (vídeo mais longo, sem custo), gerar a narração de novo (paga, nova versão) ou cancelar. Nunca cortamos fala; nunca há regeneração paga automática. Áudio mock (`measured: false`) nunca bloqueia. Arestas novas: `generating → audio_review`, `audio_review → rendering | generating | cancelled`.

## D62 — Custos reais da narração
Antes da chamada: a checagem de orçamento existente (`pauseIfOverBudget`) com a estimativa restante. Depois: custo monetário = caracteres ENVIADOS (`inputCharacters`) × preço da API do modelo → ledger (ver D67; o header `character-cost` é guardado à parte e não entra no cálculo) (`audio_generation`, `simulated: false`, `attemptId`). Falha HTTP 4xx/5xx: a ElevenLabs não cobra → sem registro. Resposta 200 inválida: provavelmente cobrada → registra. Timeout: não sabemos → a tentativa falha com aviso de "possível cobrança não confirmada" e nada é re-tentado (mesmo princípio da D33). Se salvar o arquivo falhar depois da chamada, o custo continua registrado. "Gerar narração novamente" (`startNarrationRegeneration`) é explícito, checa limite de tentativas (`MAX_ATTEMPTS_PER_SCENE`) e orçamento com o custo da narração; com orçamento excedido devolve a decisão sem chamar; a tentativa anterior vira descartada mas continua no total; falha na nova chamada mantém a anterior.

## D63 — Narração como asset versionado, independente do renderer
`LocalAudioAssetStore` grava em `<AUDIO_DIR>/<campanha>/<criativo>/v<N>/` (`narration.mp3`, `timing.json`, `metadata.json`), mesma reserva atômica de versão dos renders (`allocateVersionDir`): nada é sobrescrito. O metadata guarda provider, modelo, voz, request id, caracteres, duração, AudioFit e os textos escrito/falado (sem segredo). A tentativa de áudio guarda só URIs relativas e `NarrationInfo`. O browser ouve por `GET /api/audio/<campanha>/<criativo>/<versão>` (IDs validados, só versões registradas no job, Range). O mesmo asset serve ao Remotion hoje e a lip sync/avatar/vídeo generativo no futuro.

## D64 — Remotion com narração
Quando o manifest tem áudio real resolvido (o `AssetResolver` aceita `.mp3`/`.wav` com conteúdo conferido, nas raízes `UPLOADS_DIR` e `AUDIO_DIR`), a composição toca `<Audio>` e o MP4 sai com trilha **AAC** (H.264, 1080x1920, 30 fps continuam). Sem áudio real, o comportamento do Lote 3 continua (sem trilha, aviso `audio_unavailable`). `remotion-renderer@1.1.0`, `tiktok-creative@1.1.0`.

## D65 — campaign-plan@1.0.1
A versão ativa do prompt é a 1.0.1 = 1.0.0 + as duas regras de honestidade da D42 (sem experiência inventada; sem falsa prova), inseridas na seção "Honestidade e conformidade". Schema, validação, mensagem do usuário e limites não mudam; a 1.0.0 continua registrada (deprecated). Nenhuma chamada à Anthropic foi feita para isso; a validação real da 1.0.1 fica para quando autorizada.

## D66 — `npm test` offline por construção
`src/test/no-network.ts` (setup do Vitest) faz qualquer `fetch` fora de localhost falhar. Providers reais recebem transporte falso nos testes (`src/test/elevenlabs-fake.ts`). A validação real é só pelo script `npm run tts:real` (sem `--confirm` não chama nada; com `--confirm`, UMA chamada curta).

## D67 — `character-cost` (créditos) ≠ caracteres enviados ≠ custo monetário
Contexto: na validação real (2026-10-14, `eleven_flash_v2_5`), o texto enviado tinha 169 caracteres e o header `character-cost` veio 85. O header mede consumo de créditos/quota da assinatura (no Flash, ~0,5 crédito por caractere), não caracteres cobrados em dinheiro.
Decisão: três valores separados, nunca misturados:
- `inputCharacters` — caracteres REALMENTE enviados (texto falado); é a base do custo.
- `providerCharacterCost` — valor BRUTO do header `character-cost`; só auditoria (tentativa, metadata, UI como "consumo informado pela ElevenLabs, outra unidade").
- custo monetário — `inputCharacters` × preço por 1.000 caracteres da tabela da API (`pricing.ts`), registrado no ledger.
Aplicar o preço por 1.000 caracteres sobre o `character-cost` daria desconto duplicado (o desconto do Flash já está no preço de API) e subestimaria o gasto. Créditos/quota da assinatura e custo monetário da API são métricas relacionadas, mas de unidades diferentes; o sistema de custos usa só a segunda.

## D68 — Validação real da ElevenLabs (2026-10-14)
UMA chamada (`npm run tts:real -- --confirm`, preset economy): `eleven_flash_v2_5`, voz Clara → "Sarah", 169 caracteres falados, request id `IxjNGD1yOudqif0Kw02v`, `character-cost` 85, áudio 10,658s, fala até 10,589s, latência 1.215 ms, alvo 9s → AudioFit `too_long` (o texto de exemplo é mais longo que 9s; a política funcionou como esperado), alinhamento e legendas válidos, MP3 salvo, nenhuma retentativa. Custo monetário pela tabela atual: 169 × US$0,05/1000 = US$0,00845. Resultado levou às correções D67 e ao preço vigente na D57.


## D69 — Runway modular, opt-in e sem retry (Lote 5)
`VIDEO_PROVIDER=mock|runway` (default mock). `RunwayVideoProvider` concentra HTTP de criação/status/download; `RUNWAYML_API_SECRET` só é lida no servidor e fica em campo privado. API version `2024-11-06`, imagem local autorizada em data URI até 5 MB codificada, prompt 1–1000 caracteres, saída vertical 720:1280. Nenhum SDK novo. Um POST por tentativa, timeout de 60s por request, polling limitado a 120 consultas com intervalo de 5s. Falha/timeout nunca repete geração automaticamente; pode haver cobrança não confirmada. A tarefa aceita é registrada no job (`videoTasks`) antes do primeiro polling para auditoria após restart; não é retomada automaticamente.

## D70 — Modelo, duração comprada e custo Runway
Primeiro modelo: `RUNWAY_VIDEO` em `config/video-models.ts`, Gen-4 Turbo nos três presets quando Runway está selecionada; não se promete outro modelo nos tiers superiores. Tabela oficial da API em https://docs.dev.runwayml.com/guides/pricing/ consultada em 2026-10-14: 5 créditos/s, US$0,01/crédito, US$0,05/s. Durações conservadoras 5/10s: uma cena de 2–5s compra 5s; acima de 5 até 10 compra 10s; acima de 10 exige revisão do plano. Estimativas por cena e orçamento usam a duração COMPRADA, sem alterar a duração editorial do plano. O renderer corta o excedente do clipe. Meta de segundos do preset continua sendo duração editorial, não consumo faturado.
Custo em resposta terminal `cost.credits` é convertido em consumo equivalente para o ledger (inclusive falha/cancelamento cobrado ou reembolsado); em sucesso sem esse campo, usa duração solicitada × tarifa contratada. Não se interpreta `estimatedCost` como custo real. Download inválido/falho após sucesso conserva consumo no `ProviderError`. O ledger registra ANTES de salvar o asset: falha de disco não apaga custo.

## D71 — Clipe local versionado e substituição no renderer
`LocalVideoAssetStore` reserva `<VIDEOS_DIR>/<campaignId>/<sceneId>/vN/{clip.mp4,metadata.json}` atomicamente. Salva parcial e renomeia; versões antigas nunca são sobrescritas, e reservas incompletas são puladas. Job/manifest guardam URI relativa e task id, sem URL temporária nem segredo. Download só HTTPS em domínios de CDN autorizados, sem redirects e sem Authorization; limite 100 MB e assinatura MP4. `AssetResolver` autoriza MP4 nas raízes configuradas e confere assinatura; `buildCompositionProps` entrega vídeo real ao `OffthreadVideo` mudo. Áudio continua vindo da narração, e mock mantém placeholder explícito.
Campanhas existentes preservam configurações: mudar ambiente não reescreve preço/modelo aprovado. Factory real recusa planos antigos com outro modelo; é necessário criar nova campanha e aprovar sua estimativa. Cards de novos presets mostram a seleção do runtime. A execução continua em background no processo único e reutiliza locks, guards, orçamento e limite de tentativas existentes.

## D72 — Validação manual isolada, sem cobrança por padrão
`npm run video:real -- --image "C:/fotos/produto.jpg"` valida imagem e mostra 5s / 25 créditos / US$0,25 sem chave, rede ou gravações. Só `--confirm` autoriza criação de campanha de teste persistida, estimativa, aprovação e UMA cena paga via pipeline. Planner, áudio e renderer são forçados para mock, mesmo se o ambiente tiver outros providers. O teste não produz MP4 final; o clipe fica em VIDEOS_DIR e seu custo no ledger. Orçamento excedido bloqueia sem autorização automática. Nenhuma validação real foi feita neste lote; chave, qualidade visual, CDN efetiva e composição MP4 final ficam para a primeira execução autorizada.

## D73 — Integridade de duração do clipe real
Contexto: na 1ª geração real (Gen-4 Turbo, 5s pedidos) o clipe pareceu ter ~1s. A investigação local (ffprobe do arquivo salvo) mostrou que o MP4 tem **5,042s, 121 quadros, 24 fps, 720×1280**, completo e decodificável: o problema foi de reprodução/percepção, não do arquivo (ver docs/RUNWAY.md). Mesmo assim, nada garantia isso no pipeline.
Decisão: depois de salvar o clipe, o pipeline lê a duração REAL do MP4 gravado (`inspectMp4`: trilha de vídeo via `mdhd`, completude das caixas) e persiste separadamente `requestedDurationSeconds`, `providerReportedDurationSeconds` (a tarefa da Runway não informa → ausente) e `actualMediaDurationSeconds` (`attempt.media` + `integrity.json` ao lado do clipe). Tolerância: max(0,25s; 5% do pedido). Fora dela (ou arquivo incompleto/ilegível): tentativa `failed`, nunca ativa, `rejectedAssetUri` só para auditoria, custo já registrado mantido, nenhuma nova tentativa, clipe nunca vai ao Remotion, job `failed` com mensagem clara (solicitado/provider/arquivo real). `npm run video:real` imprime as três durações.


## D74 — Presenter offline de áudio, separado do vídeo genérico

Use `/v1/avatar_videos`, `gwm1_avatars`, `avatar.type=runway-preset`, `speech.type=audio`; não usar sessão conversacional nem TTS Runway. A narração ElevenLabs/alignment vêm primeiro. Recorte local PCM por janela alinhada, validação do WAV antes de enviar e do MP4 no disco depois de baixar. Timeline de presenter segue os mesmos limites da fala; áudio do clipe mudo no render, narração contínua uma única vez. Presets selecionáveis na criação, sem personagens customizados automáticos. `presenterProviderFactory` é independente de `videoProviderFactory`.

## D75 — Presenter durável, sem reenvio pago implícito

Intenção submitting persistida antes do POST, pending com ID/requestId antes do polling. Reinício/timeout retoma a task por ação explícita; intenção sem ID não é reenviada. Tarifa específica do endpoint (1 crédito/3s), arredondamento conservador por clipe; task.cost prevalece, sucesso sem cost usa tarifa. Custo antes de salvar/validar, deduplicado pela tentativa na retomada. O clipe segue versionamento e os três campos de duração da D73. Regenerar vídeo exige confirmação; após falha terminal, nova estimativa/aprovação. Narração com presenter ativo não é substituída isoladamente para não deixar lábios antigos com voz nova. CLI presenter:real copia áudio de um job existente para campanha isolada e faz no máximo um POST; dry-run só lê. Product UGC fica em preparação de contrato sem transporte, autorização de imagem obrigatória e audio=false (voz externa em off, sem prometer lip sync). Detalhes/fontes em docs/PRESENTERS.md.

## D76 — Execução híbrida com autorização por unidade

Substitui a trava absoluta de ff176bb na interface por modos independentes (MOCK default) de planejamento, narração, cenas, avatar e render. Disponibilidade REAL depende de configuração local do provider e é validada no servidor. Planejamento REAL cria draft antes de qualquer chamada; só inicia após revisão do pior caso e aprovação. Retries do Claude ficam em zero (transporte) e uma tentativa de saída estruturada nesse fluxo.

PipelineService reutiliza providers, orçamento, ledger, assets e renderer existentes. executeStage valida cotação atual sob lock e persiste aprovação; executa só uma unidade paga e retorna WAITING_STAGE. Cenas distintas exigem cliques distintos. Autorização de transporte é um escopo AsyncLocalStorage efêmero com uma criação paga; polling usa a autorização sem permitir outro POST. Ações antigas não podem contornar a aprovação por etapa. CLI com --confirm isolado permanece bloqueada.

Modes/revisões/intenções/aprovações vivem no job; request guarda seleção inicial. Trocar modo não apaga ou desativa mídia; só sucesso de nova geração substitui a ativa. Nova versão requer outra cotação, respeitando MAX_ATTEMPTS_PER_SCENE. Render separado fica marcado como desatualizado quando mídia muda. Avatar REAL requer MP3/alignment reais; avatar MOCK aceita narração real, sem alegar lip sync real. Roteiro já planejado muda via cópia para não invalidar cenas/áudio existentes.

Ledger continua append-only, com custo simulado separado do dinheiro real no orçamento híbrido. Cada escopo de excedente tem confirmação própria e teto mostrado. Runway genérico ganha intenção antes do POST e retomada pelo ID; envio sem ID bloqueia repetição. Tentativa/custo de vídeo são deduplicados na retomada. Duração, integridade e versionamento reais continuam nas camadas existentes. Ver HYBRID-WORKFLOW.md. Nenhuma chamada paga na implementação.

Compatibilidade D76: os projetos offline de ff176bb podem adotar o modo híbrido explicitamente no próprio job, preservando plano, assets, aprovação e ledger. Só projetos reais antigos/sem identificação ficam em consulta e usam cópia.

## D77 — Prontidão e preflight locais antes da validação integrada

Configuração inválida não deve derrubar toda a interface nem ser corrigida implicitamente para um provider real. `loadAppConfigSafe` remove apenas campos rejeitados pelo schema, usa o default MOCK e publica mensagens orientadas, nunca valores de segredo. O diagnóstico informa seleção e presença booleana de Anthropic, ElevenLabs e Runway, renderer, navegador e dependências. `VIDEO_PROVIDER=RUNWAYML`, por exemplo, orienta usar `runway` e permanece MOCK.

O navegador do Remotion é detectado por existência do executável configurado ou do Chrome Headless Shell baixado; a leitura nunca instala nada. Render REAL só fica disponível quando `RENDERER=remotion` e o navegador existe. `render:setup` é instalação explícita; `render:check` é diagnóstico sem rede.

Toda cotação por etapa inclui preflight de provider/configuração, assets, narração/alignment e avatar quando aplicáveis, duração, tentativas, orçamento e confirmação. O painel é informativo; a segurança continua no servidor: a execução refaz a cotação sob lock, verifica token/orçamento/estado e cria autorização efêmera para uma única chamada. A próxima ação é derivada das cotações na camada application. Nenhuma cascata, retry pago, mutação do ledger ou simplificação das proteções existentes.

O protocolo futuro é deliberadamente pequeno: uma narração, uma cena curta de avatar, uma cena curta de produto e um render local, cada item com cotação e clique próprios. A implementação é validada em MOCK e com transportes falsos; chamadas reais continuam pendentes de autorização. Product UGC real permanece desabilitado.

## D78 — Fluxo simples com storyboard e autorização única do job

Novos projetos da interface usam `simpleFlow`, com Produto → preset → storyboard → teto → geração automática. Os presets de apresentação são Econômico (15–20s), Equilibrado (20–30s) e Premium (30–45s); os settings históricos continuam intactos para não reinterpretar campanhas existentes. O formulário exige só nome, imagens opcionais e descrição curta opcional. “Melhorar informações com IA” estrutura localmente apenas fatos fornecidos no MOCK; com planejamento REAL, a análise do Claude continua atrás da cotação e aprovação existentes.

O storyboard é persistido no plano antes da mídia. Editar uma cena recalcula a revisão e a estimativa, invalida a cotação anterior e é recusado depois que existem assets. Product UGC continua fora da lista selecionável, embora `VisualSource` permaneça preparado para ele.

`JobAuthorization` persiste cotação, custo real de base, teto, status e motivo de pausa. Um clique autoriza a sequência narração → avatar → cenas → render. Cada unidade ainda recebe autorização efêmera, guard de orçamento, ledger e limite de tentativas nas camadas existentes. A sequência para no primeiro erro, custo incerto, revisão de áudio ou aumento; não há retry pago. Reinício nunca retoma sozinho: a UI oferece continuação explícita com nova cotação, preservando o teto e o histórico. Regeneração de cena permanece explícita, versionada e separada.


## D79 — AI UGC como modo criativo próprio, separado do Presenter

`creativeMode: "ai_ugc"` é um modo do fluxo simples, não um tipo de apresentador. Presenter (D74/D75) anima um avatar falando a narração; não segura produto nem tem identidade persistida por job. AI UGC gera uma PESSOA SEGURANDO/APRESENTANDO O PRODUTO REAL a partir da foto. Por isso há dois contratos novos, `UgcReferenceProvider` (imagem pessoa + produto) e `UgcVideoProvider` (clipes a partir da referência aprovada), em `src/providers/ugc/`, e duas etapas novas no job: `ugc_reference` e `ugc_video`. Em AI UGC o Presenter nunca é chamado; campos de apresentador do request são limpos.

Cenas: `ugc_hook`, `ugc_demo`, `ugc_benefit`, `ugc_cta` (pessoa, via UgcVideoProvider) e `product_broll` (produto sem pessoa, via VideoProvider genérico, categoria de custo `broll`). `product_image`/`text_card` continuam no Remotion. Presets: Econômico = hook + imagem + CTA; Equilibrado = hook + benefício + B-roll + imagem + CTA; Premium = hook + demo + B-roll + benefício + B-roll + CTA (`config/ugc.ts`). Nichos não são fixos: o ambiente é sugerido por palavras do produto, com fallback "sala".

## D80 — Referência UGC aprovada antes de qualquer cena UGC

Ordem do job: `ugc_reference → narration → ugc_video → avatar → scenes → render`. A referência é persistida (`job.ugc.references[]`, versão vN, intenção durável `submitting → pending → succeeded|failed`) e, quando real, salva em `UGC_DIR/<campanha>/<criativo>/vN/` com escrita atômica; o browser só recebe IDs (`/api/ugc/...`). Após gerar, a cotação devolve `awaitingReview` e o job pausa com `waitingForStage: "ugc_reference"` SEM erro. A tela mostra "Esta será a pessoa apresentando seu produto" com Aprovar / Gerar outra referência / Trocar apresentador / Trocar ambiente / Editar conceito.

`ugc_video` é bloqueado na cotação e no fluxo (`UgcReferenceRequiredError`) sem referência aprovada da identidade ATUAL. Aprovar, regenerar ou trocar identidade reativa a MESMA `JobAuthorization` pausada e relança a sequência sob o mesmo teto e baseline; uma nova referência é só mais uma unidade dentro do teto (limite `MAX_ATTEMPTS_PER_SCENE`), nunca retry automático. Trocar apresentador/ambiente incrementa `identity.revision` e invalida a aprovação; ambos são recusados depois que existe cena UGC (consistência). Envio real sem resposta fica `submitting` incerto: bloqueia repetição até decisão humana.

## D81 — Consistência de identidade por job; biblioteca futura só em estrutura

`UgcCharacterIdentity` (gênero, faixa etária, aparência, figurino, ambiente, estilo, revisão) é resolvida de forma determinística (hash FNV, sem `node:crypto` porque o wizard importa) e persistida no job. Toda cena UGC recebe a mesma referência aprovada, identidade e produto-âncora (`UgcProductAnchor`: imagem, nome, descrição e `preserve` = forma, cores, logo, embalagem, proporções), e cada tentativa grava `attempt.ugc` (referência, versão, identidade, figurino, ambiente, imagem do produto, estratégia de áudio, fala e ação) para auditoria. `UgcCharacterProfile` (biblioteca futura, `imageConsent` default false, tags livres) existe só como schema; nada a usa ainda.

## D82 — Estratégia de áudio declarada pelo UgcVideoProvider

Cada `UgcVideoProvider` declara `audioStrategy`:
- `native_speech`: o modelo de vídeo gera a fala. A etapa de narração é pulada (sem linha de TTS na estimativa); `mediaComplete` não exige narração; cenas não-UGC ficam sem fala; o manifest marca `clipAudio: true` só nas cenas UGC e o Remotion desmuta apenas elas.
- `external_lipsync`: narração ElevenLabs primeiro; cada cena UGC recebe sua janela do MP3 (`presenterPreview`) para lip-sync; clipes ficam mudos.

Áudio duplicado é impossível por construção: o manifest lança "Áudio duplicado…" se uma cena com áudio próprio coexistir com narração real; o fluxo recusa clipe cujo `hasAudio` contradiz a estratégia. O mock usa `UGC_MOCK_AUDIO_STRATEGY` (default `native_speech`).

## D83 — Fala UGC natural, sem experiência inventada

Prompt `campaign-plan@1.5.0` (ativo) instrui linguagem de criador ("Olha isso aqui…", "Se você procura…", "Esse modelo chama atenção por…") e proíbe experiência/depoimento inventados ("uso há meses", "testei", "funcionou comigo", "comprei", depoimentos) e jargão de anúncio. `ai/ugc-script.ts` valida isso de forma determinística e checa que a fala cabe na cena (≤ 2,8 palavras/s); a validação do prompt recusa saída que viole, e o modo `standard` recusa fontes UGC. Editar cena no storyboard aplica as mesmas regras.

## D84 — Custos UGC provisórios e contrato Google/Veo sem transporte

Novas categorias: `ugc_reference`, `ugc_scene`, `broll` (além de voz e render). A estimativa conta uma referência + segundos por cena UGC + B-roll, sem TTS em `native_speech`. Preços são PLACEHOLDER (`unassigned-ugc`, `isPlaceholder: true`, "sem fonte oficial") em `config/pricing.ts`; nenhum preço real foi inventado. A UI já sinaliza preço provisório.

Google/Veo/Flow: `google-ugc-contract.ts` só PREPARA o corpo (`verified: false`, `generateAudio: true`, recusa áudio externo) e `GOOGLE_UGC_CANDIDATES` lista candidatos não verificados. Não há transporte, chave ou chamada; o modo REAL de `ugc_reference`/`ugc_video` fica indisponível com motivo explícito. Automação da interface web do Flow é proibida: só API oficial.
