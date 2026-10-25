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

### Quote existente + intent durável de autorização

Após os guards de elegibilidade, a cotação reutiliza `quoteStage(jobId, derivedStage, false, true, sceneId)`. Ao aceitar o token, `retryFailedScene` grava no mesmo save a aprovação, o `stageApproval` e uma `SceneRetryIntent` durável antes de tentar enfileirar.

A intent vincula token, cena, tentativa falha, próximo número de tentativa, estimate, revisões, recipe, modo, provider, modelo e custo. Ela pode estar `authorized`, `queued`, `running` ou `settled`. Assim, uma queda depois da aprovação e antes do enqueue não perde a autorização: o replay encontra a intent `authorized` e agenda exatamente o mesmo `JobRun`, sem pedir novo gasto.

Não há validade por relógio. A validade é por contexto: mudar tentativa, estado, preço, câmbio, provider, modelo, modo, revisão ou decisão de orçamento torna a quote stale. O orçamento é rechecado sob lock mesmo quando o token não muda.

### Idempotência em camadas

- lock: duas aprovações concorrentes criam uma única intent;
- `SceneRetryIntent`: é a âncora de replay antes e depois do enqueue, inclusive quando a resposta HTTP se perde;
- dedupe ativo continua `job:<jobId>`, mas a fila compara o payload: replay do mesmo `scene_retry` é aceito; operação diferente enquanto o job está ativo é recusada em vez de ser engolida silenciosamente;
- operation/attempt ID: depois do submit, só permite polling/download do mesmo trabalho.

O wrapper HTTP genérico não é usado nesta rota. Uma queda enquanto sua tabela estivesse em `in_progress` não possui takeover seguro e poderia bloquear justamente a recuperação necessária. O replay da rota retorna o estado aceito atual a partir da intent durável; não promete repetir byte a byte a primeira resposta.

### Operação paga incerta

Antes de emitir quote executável, `quoteFailedSceneRetry` consulta `paidOperationInFlight(job)`. Qualquer intent real `running`, referência/operação UGC não liquidada, Presenter `submitting|pending` ou vídeo `submitting|pending` bloqueia a quote, mesmo em outra cena do job.

ID conhecido da própria operação segue o caminho de polling/download existente e não vira nova tentativa. Sem ID confirmado, permanece “pausada por segurança”, sem token executável.

### Estado e versionamento

Não criar novos status:

- `failed`: sem tentativa ativa e última tentativa falha; `retryQuote` pode estar pronta ou bloqueada;
- aprovação: job `generating`, tarefa `queued/running`;
- sucesso: nova tentativa ativa, versões anteriores preservadas, cena `ready`, render stale e recomposição grátis opcional;
- nova falha: nova tentativa no histórico, cena `failed`, token anterior inválido e nova aprovação obrigatória.

Se a intent fica stale entre aprovação e execução, ela é liquidada como `blocked`, o job volta a `failed` e uma nova quote pode ser apresentada. Nenhum provider é chamado nesse caminho.

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

- Não alterar lease, heartbeat ou recovery geral do worker. A fila recebe apenas a validação mínima de payload no dedupe ativo.
- Não alterar providers, requests, preços, credits, Product Fidelity ou áudio.
- Não criar retry automático nem reutilizar autorização velha.
- Não redesenhar telas; apenas alimentar a UI existente e ajustar copy mínimo se necessário.
- Não remover “Refazer esta cena” pronta nem componentes antigos.
- Não executar provider real em implementação ou testes.
