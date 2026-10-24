# L8.8.2 — Safe Scene Retry

## Causa raiz confirmada

O fluxo atual mistura duas decisões distintas no mesmo campo `SceneView.regenerationQuote`:

- `getCampaignView`, em `src/application/campaign-actions.ts`, cria `quoteStage(..., regenerate=true, sceneId)` somente para cenas geradas com estado visual `ready`;
- `buildProjectV2View`, em `src/application/project-v2-view.ts`, só oferece `retry: "scene"` para uma cena `failed` quando essa mesma cena possui `regenerationQuote.ready`.

Uma cena falha não entra no filtro que cria a cotação e normalmente cai no retry do job. A hipótese inicial está confirmada: a quote de “nova versão de cena pronta” foi parcialmente reutilizada como se fosse a quote de “recuperar tentativa falha”, embora sejam decisões de gasto diferentes.

Há duas inconsistências relacionadas:

1. `GenerationProject` e `ProjectV2` enviam sempre `stage: "ugc_video"`, embora existam três recipes: `avatar`, `ugc_video` e `scenes`.
2. `POST /v1/jobs/:id/scenes/:sceneId/retry` não usa o repositório de `Idempotency-Key` já aplicado à autorização do job. Lock, token mutável e dedupe da fila evitam dois submits na maioria das corridas, mas a API não dá replay idempotente quando a resposta se perde.

## Fluxo atual observado

1. A geração cria uma tentativa com `attemptId`, provider, modelo e número.
2. Presenter persiste `presenterTasks`; AI UGC persiste `ugcVideoOperations`; vídeo comum persiste `videoTasks`. Todos persistem a tentativa terminal na cena.
3. Falha terminal grava `MediaAttempt { status: "failed", active: false }`; sucesso grava `active: true` e desativa a versão anterior.
4. Uso faturado é acrescentado ao ledger por tentativa; entradas anteriores não são alteradas. MOCK fica `simulated`.
5. `performHybridStage` transforma a falha da tentativa em falha do job, e o fluxo automático pausa a autorização do job.
6. `quoteStage` calcula provider, modelo, custo, dependências, tentativas e orçamento. Seu token é o fingerprint do job atual mais etapa, modo, unidade, custo, provider, modelo, decisão de orçamento e `regenerate`.
7. `prepareStage` refaz a quote sob lock, compara o token, revalida orçamento, persiste `approval` e `stageApproval`, muda o job para `generating` e só então enfileira.
8. O worker grava `stageIntents` antes de chamada real. Sem ID confirmado, uma operação incerta não é reenviada.
9. A fila limita a uma tarefa ativa por `job:<jobId>`; o lock serializa aprovação; preparar a primeira execução muda o job e invalida o mesmo token.
10. `startRerender` no híbrido retoma trabalho seguro/MOCK interrompido; mídia paga ainda exige nova quote e aprovação. Ele não substitui autorização específica de cena.

## Comportamento desejado

```text
cena com última tentativa terminal failed
  → quote nova da recuperação da cena
  → usuário vê custo e confirma
  → servidor recalcula e valida sob lock
  → uma tarefa daquela cena
  → um submit novo, ou retomada pelo operation ID existente
  → sucesso: nova tentativa ativa e cena ready
  → nova falha: nova tentativa failed e novo token obrigatório
```

`retryQuote` representa recuperação de falha; `regenerationQuote` continua representando uma nova versão de cena pronta.

## Arquitetura escolhida

### Contrato único de recovery

Adicionar ao `PipelineService` operações equivalentes a:

- `quoteFailedSceneRetry(jobId, sceneId): Promise<StageQuote>`;
- `retryFailedScene(jobId, sceneId, token)`.

O servidor localiza a cena no plano e deriva o stage com a regra já existente:

- `presenter` → `avatar`;
- cenas `ugc_*` com pessoa → `ugc_video`;
- demais cenas geradas, incluindo produto/B-roll → `scenes`.

O contrato exige: cena pertencente ao job, `requiresGeneratedVideo`, nenhuma tentativa ativa e última tentativa terminal `failed`. Cena pronta, planejada ou de outra campanha é rejeitada. O cliente não escolhe o recipe.

### Reutilizar quote e aprovação existentes

Não criar um segundo schema persistente de autorização. Após os guards de elegibilidade, reutilizar `quoteStage(jobId, derivedStage, false, true, sceneId)` e `executeStage`.

O token atual já vincula o contexto necessário: job/campaign, `unit = sceneId`, histórico de attempts, modo, provider, modelo, custo, budget decision, estimate, `stageRevision`, `storyboardRevision` e `regenerate`. `retryFailedScene` repete o guard de última tentativa falha antes da preparação sob lock. `stageApprovals` continua auditando stage, unidade, token, provider, modelo e custo.

Não há validade por relógio. A validade é por contexto: mudar tentativa, estado, preço, câmbio, provider, modelo, modo, revisão ou decisão de orçamento torna a quote stale. O orçamento é rechecado sob lock mesmo quando o token não muda.

### Idempotência existente, em camadas

Aplicar o wrapper `idempotent` à rota de retry e enviar uma `Idempotency-Key` estável derivada de `{jobId, sceneId, token}`. Escopo sugerido: `retry_scene:<jobId>:<sceneId>`.

- repositório de idempotência: replay HTTP devolve a mesma resposta;
- lock: duas aprovações concorrentes não passam juntas;
- fingerprint do job: o token torna-se single-use após persistir status/approval;
- dedupe `job:<jobId>`: uma tarefa ativa por job;
- intent/operação/attempt ID: impede novo POST depois do início e permite apenas polling/download com ID conhecido.

Se a API cair depois de persistir aprovação e antes do enqueue, nenhum submit ocorreu e o token anterior já não autoriza outra tentativa. A recuperação permanece explícita; não haverá compensação com submit automático.

### Operação paga incerta

Antes de emitir quote executável, `quoteFailedSceneRetry` consulta `paidOperationInFlight(job)`. Qualquer intent real `running`, referência/operação UGC não liquidada, Presenter `submitting|pending` ou vídeo `submitting|pending` bloqueia a quote, mesmo em outra cena do job.

ID conhecido da própria operação segue o caminho de polling/download existente e não vira nova tentativa. Sem ID confirmado, permanece “pausada por segurança”, sem token executável.

### Estado e versionamento

Não criar novos status:

- `failed`: sem tentativa ativa e última tentativa falha; `retryQuote` pode estar pronta ou bloqueada;
- aprovação: job `generating`, tarefa `queued/running`;
- sucesso: nova tentativa ativa, versões anteriores preservadas, cena `ready`, render stale e recomposição grátis opcional;
- nova falha: nova tentativa no histórico, cena `failed`, token anterior inválido e nova aprovação obrigatória.

## Invariantes de segurança

1. Nenhum submit sem quote atual e confirmação explícita.
2. A autorização vale para um job, uma cena e o contexto atual da tentativa.
3. Stage/recipe é derivado no servidor.
4. Quote de cena pronta não passa pelo recovery.
5. Token de outra cena/job, adulterado ou stale é rejeitado antes do provider.
6. Ownership continua vindo do runtime/repositório por `user_id`.
7. Operação paga incerta bloqueia quote executável e submit.
8. Clique duplo, replay e corrida resultam em no máximo um submit.
9. Mudança de preço/provider/modelo/configuração exige nova quote; orçamento é rechecado.
10. Cada tentativa usa novo `attemptId`; ledger append-only e deduplicado na retomada.
11. Falha nunca aciona retry automático.
12. MOCK não faz rede e continua fora do custo real.

## Recipes afetados

- Presenter/avatar: reutiliza narração/alignment e `presenterTasks`; retry não chama TTS de novo.
- AI UGC (Product UGC atual): exige referência/fidelidade/identidade e usa `ugcVideoOperations`; mantém a estratégia de áudio.
- Produto/B-roll gerado: usa `VideoProvider`, `videoTasks` e `executeAttempt`.
- Imagem estática/text card: não recebe retry pago de cena.

## Não objetivos

- Não alterar fila, lease, heartbeat ou recovery do worker.
- Não alterar providers, requests, preços, credits, Product Fidelity ou áudio.
- Não criar retry automático nem reutilizar autorização velha.
- Não redesenhar telas; apenas alimentar a UI existente e ajustar copy mínimo se necessário.
- Não remover “Refazer esta cena” pronta nem componentes antigos.
- Não executar provider real em implementação ou testes.
