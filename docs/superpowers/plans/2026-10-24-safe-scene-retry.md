# L8.8.2 — Safe Scene Retry: Implementation Plan

> Spec normativa: [2026-10-24-safe-scene-retry.md](../specs/2026-10-24-safe-scene-retry.md)

**Objetivo:** fazer uma cena terminalmente falha receber nova cotação específica, exigir aprovação explícita e executar no máximo um retry daquela cena, preservando orçamento, retomada, versionamento e ledger.

**Estratégia executada:** adicionar um contrato de recovery no `PipelineService` que derive o recipe no servidor, persista uma intent antes do enqueue e separe `retryQuote` de `regenerationQuote` na view. O dedupe da fila mantém a chave por job, mas valida que o payload ativo é o mesmo. Providers e preços não mudam.

**Regra TDD:** em cada tarefa, escrever o teste RED primeiro, executar o comando indicado e confirmar que a falha é a esperada antes de alterar produção. Não usar transporte real.

## Tarefa 1 — Cotação explícita para cena falha

**Arquivos:**

- modificar `src/pipeline/hybrid-service.test.ts`;
- modificar `src/pipeline/pipeline-service.ts`.

**Interfaces:** adicionar `PipelineService.quoteFailedSceneRetry(jobId: string, sceneId: string): Promise<StageQuote>`. Tornar a derivação do stage reutilizável internamente, sem expor `stage` como autoridade do cliente.

**Teste RED:** preparar jobs com cena `failed`, `ready`, `planned`, ID inexistente e ID de outra campaign. Para falha terminal, esperar quote pronta com `unit === sceneId`, custo/provider/modelo do recipe atual e token novo. Para os demais, esperar quote bloqueada/erro sem token executável. Cobrir Presenter (`avatar`), AI UGC (`ugc_video`) e produto/B-roll (`scenes`).

**RED:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts -t "cotação de retry da cena falha"
```

**Implementação mínima:** localizar job, campaign, creative e cena; validar pertencimento, `requiresGeneratedVideo`, ausência de tentativa ativa e última tentativa `failed`; derivar stage pela regra existente; chamar `quoteStage(..., regenerate=true, sceneId)`. Se `paidOperationInFlight(job)` existir, devolver quote bloqueada e sem `ready`. Não alterar a quote de cena pronta.

**GREEN:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts -t "cotação de retry da cena falha"
```

**Commit sugerido:** `test(pipeline): specify failed scene retry quotes`

## Tarefa 2 — Aprovação single-use, stale quote e nova falha

**Arquivos:**

- modificar `src/pipeline/hybrid-service.test.ts`;
- modificar `src/pipeline/pipeline-service.ts`;
- modificar `src/application/campaign-actions.ts`.

**Interfaces:** adicionar `PipelineService.retryFailedScene(jobId, sceneId, token)` e `retryFailedScene(deps, {jobId, sceneId, token})`. A ação não recebe stage.

**Teste RED:** cobrir:

1. sem token/aprovação válida → zero submits;
2. token da própria quote → exatamente um submit;
3. mesmo token duas vezes/concorrentemente → exatamente um submit;
4. token adulterado, de outra cena ou outro job → zero submits;
5. preço, provider, modelo, modo, revisão ou tentativa alterados após quote → stale, zero submits;
6. attempt 1 falha → quote/token A → attempt 2 falha → token A não autoriza attempt 3; quote/token B é necessária;
7. cena `ready` é rejeitada no recovery, embora continue elegível na regeneração separada.

**RED:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts -t "retry seguro de cena falha"
```

**Implementação mínima:** `retryFailedScene` revalida elegibilidade e ausência de operação paga em voo, deriva stage e delega a `executeStage(jobId, stage, token, {regenerate: true, sceneId, thenFreeRender: true})`. A validação final permanece em `prepareStage`, sob lock. Preservar `stageApprovals`; não criar autorização genérica.

**GREEN:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts -t "retry seguro de cena falha"
```

**Commit sugerido:** `feat(pipeline): authorize one failed scene retry`

## Tarefa 3 — Recipes e ledger append-only

**Arquivos:**

- modificar `src/pipeline/presenter-flow.test.ts`;
- modificar `src/pipeline/ugc-flow.test.ts` ou `src/pipeline/ugc-google-flow.test.ts`, conforme o harness usado;
- modificar `src/pipeline/hybrid-service.test.ts`;
- produção somente se um teste revelar gap: `src/pipeline/presenter-flow.ts`, `src/pipeline/ugc-flow.ts` ou `src/pipeline/pipeline-service.ts`.

**Interfaces:** nenhuma nova além da tarefa 2.

**Teste RED:**

- Presenter falho: nova quote/aprovação, um submit Presenter, nenhuma nova chamada TTS, versões preservadas;
- AI UGC falho: referência/identidade preservadas, um submit UGC e nenhum Presenter;
- produto/B-roll falho: um submit do VideoProvider correto;
- retry real acrescenta exatamente a nova entrada prevista no ledger com novo `attemptId`, sem alterar custo anterior;
- retomada por provider/operation ID não cria segunda entrada;
- MOCK cria tentativa/custo simulado, sem custo real nem rede.

**RED:**

```bash
npx vitest run src/pipeline/presenter-flow.test.ts src/pipeline/ugc-flow.test.ts src/pipeline/ugc-google-flow.test.ts src/pipeline/hybrid-service.test.ts -t "retry"
```

**Implementação mínima:** preferencialmente nenhuma: os recipes já versionam e deduplicam por attempt ID. Se o RED expuser divergência, corrigir só o adapter/chamada que perdeu `sceneId` ou reutilizou attempt incorretamente; não mudar provider nem fórmula de custo.

**GREEN:**

```bash
npx vitest run src/pipeline/presenter-flow.test.ts src/pipeline/ugc-flow.test.ts src/pipeline/ugc-google-flow.test.ts src/pipeline/hybrid-service.test.ts -t "retry"
```

**Commit sugerido:** `test(pipeline): cover scene retry recipes and ledger`

## Tarefa 4 — Expor a quote correta no view model

**Arquivos:**

- modificar `src/application/campaign-view.ts`;
- modificar `src/application/campaign-actions.ts`;
- modificar `src/application/project-v2-view.ts`;
- modificar `src/application/generation-view.test.ts`;
- modificar `src/components/generation/generation.test.ts` apenas se houver ajuste visual mínimo.

**Interfaces:** adicionar `SceneView.retryQuote?: StageQuote`; manter `regenerationQuote` para cenas prontas. `ProjectV2View.error.sceneToken` passa a vir somente de `failed.retryQuote`.

**Teste RED:** cena falha com quote pronta exibe retry individual e custo; quote bloqueada por operação incerta não oferece botão executável e mostra segurança; cena pronta conserva “Refazer esta cena”; ready nunca aparece como recovery.

**RED:**

```bash
npx vitest run src/application/generation-view.test.ts src/components/generation/generation.test.ts -t "retry de cena"
```

**Implementação mínima:** em `getCampaignView`, continuar preenchendo `regenerationQuote` para `ready` e preencher `retryQuote` para `failed` com `quoteFailedSceneRetry`. Em `buildProjectV2View`, usar `retryQuote`. Reutilizar componentes; ajustar copy apenas para mostrar o teto da tentativa se necessário.

**GREEN:**

```bash
npx vitest run src/application/generation-view.test.ts src/components/generation/generation.test.ts -t "retry de cena"
```

**Commit sugerido:** `fix(ui): expose failed scene retry quote`

## Tarefa 5 — Rota segura, ownership e replay HTTP

**Arquivos:**

- modificar `src/app/actions.ts`;
- modificar `src/cloud/api/app.ts`;
- modificar `src/components/generation/generation-project.tsx`;
- modificar `src/components/v2/project-v2.tsx`;
- modificar `src/cloud/cloud-runtime.test.ts`;
- modificar `src/cloud/worker/worker.test.ts` somente se o caso de queue não couber no runtime test.

**Interfaces:** o recovery usa `retryFailedSceneAction({jobId, sceneId, token})`; o endpoint deixa de aceitar `stage`. A regeneração técnica de cena pronta mantém a ação atual. A rota usa a `SceneRetryIntent` como âncora de replay; não usa o wrapper HTTP genérico, pois seu estado `in_progress` não tem takeover seguro após queda.

**Teste RED:**

- mesma `Idempotency-Key` e corpo → mesma resposta e uma tarefa;
- requests concorrentes ou chaves diferentes para o mesmo token → no máximo uma tarefa/submit;
- mesma chave com corpo diferente → erro;
- usuário B não autoriza job de A;
- scene ID de outra campaign, token de outra cena e token adulterado → falha;
- replay após perda de resposta não cria segunda tarefa paga.

**RED:**

```bash
npm run test:cloud -- --run src/cloud/cloud-runtime.test.ts -t "retry individual idempotente"
```

**Implementação mínima:** chamar a nova ação sem stage; persistir a intent antes do enqueue; aceitar replay do mesmo payload e recusar payload diferente sob a mesma tarefa ativa. Manter `PostgresPipelineStore`, lease e heartbeat inalterados.

**GREEN:**

```bash
npm run test:cloud -- --run src/cloud/cloud-runtime.test.ts -t "retry individual idempotente"
```

**Commit sugerido:** `fix(cloud): make failed scene retry idempotent`

## Tarefa 6 — Operação incerta e recovery do worker

**Arquivos:**

- modificar `src/pipeline/hybrid-service.test.ts`;
- modificar `src/cloud/worker/worker.test.ts`;
- produção apenas se necessário: `src/pipeline/pipeline-service.ts`.

**Interfaces:** nenhuma nova.

**Teste RED:** para `stageIntents.running`, Presenter submitting/pending, UGC submitting/pending/uncertain e vídeo submitting/pending, a cena falha não recebe quote executável e gera zero submits. Com provider/operation ID, a retomada usa polling/download pelo mesmo ID; sem ID, permanece bloqueada. Lease expirado com chamada em voo continua `blocked`.

**RED:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts src/cloud/worker/worker.test.ts -t "operação paga incerta"
```

**Implementação mínima:** usar `paidOperationInFlight(job)` no contrato de quote/retry. Não alterar `recoverExpired`, lease, heartbeat ou estados da fila.

**GREEN:**

```bash
npx vitest run src/pipeline/hybrid-service.test.ts src/cloud/worker/worker.test.ts -t "operação paga incerta"
```

**Commit sugerido:** `test(safety): block scene retry during uncertain paid work`

## Tarefa 7 — Documentação e verificação completa

**Arquivos:**

- modificar `docs/DECISIONS.md` com a decisão L8.8.2;
- modificar `docs/TASKS.md` com o resultado e testes;
- revisar esta spec e este plano só se a implementação provar uma premissa falsa.

**Interfaces:** nenhuma.

**Teste RED:** não aplicável; revisar primeiro o diff contra os invariantes da spec.

**Verificação final:**

```bash
npm run lint
npm run typecheck
npm test
npm run test
npm run test:cloud
npm run build
git diff --check
```

Não executar scripts `*:real`, não carregar `.env` e não chamar providers.

**Commit sugerido:** `docs: record safe scene retry guarantees`

## Review focus obrigatório

1. **Double-submit:** repetir ação, request e worker recovery; confirmar uma tarefa ativa e um provider submit.
2. **Stale quote:** mudar custo/configuração/attempt/revisão entre quote e clique; confirmar rejeição antes do provider.
3. **Wrong scene/wrong user:** cruzar token/scene/job e ownership; confirmar erro seguro e zero tarefas.
4. **Uncertain paid operation:** qualquer intent/operação não liquidada bloqueia token; ID conhecido só retoma, nunca resubmete.
5. **Nova falha após retry:** attempt 2 falha, token anterior fica inválido e attempt 3 exige quote/aprovação novas.

## Riscos

- O snapshot de atividade da API pode ficar defasado durante uma request; segurança não pode depender só dele. Token sob lock e intent persistida continuam obrigatórios.
- Cair depois de persistir aprovação e antes do enqueue deixa uma intent `authorized`; repetir a ação explicitamente agenda essa mesma operação uma vez.
- `paidOperationInFlight` é por job, não por cena; o bloqueio conservador é intencional porque a fila serializa o job inteiro.
- UGC e Presenter têm retomadas diferentes; a camada comum apenas escolhe recipe e preserva os guards específicos.
- Ledger de vídeo, Presenter e UGC deduplica por caminhos diferentes; testar cada um, sem unificá-los neste lote.
- `regenerationQuote` de cena pronta deve permanecer funcional e nunca ser aceita pelo recovery.
