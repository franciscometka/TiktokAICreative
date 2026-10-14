# Tarefas por lote

## Lote 0 — Fundação ✅
- [x] Análise, riscos e decisões; projeto Next.js + TS + Tailwind + Zod + Vitest + ESLint
- [x] Domínio (Zod), custos, presets, orçamento, ledger, providers mock, pipeline, estados, aprovação, manifest
- [x] Testes, lint, typecheck, `.env.example`, `CLAUDE.md`

## Lote 1 — Planejamento real com Claude + persistência local ✅
- [x] Modelos Claude por preset centralizados (`config/llm-models.ts`): Sonnet 5.5 / Sonnet 5.5 / Opus 5.5; Haiku 5.5 reservado
- [x] Preços Claude com tarifas de cache (escrita/leitura)
- [x] Persistência local atômica: campanhas, jobs (estimativas, aprovações, estado), ledger e chamadas de LLM (JSON + JSONL)
- [x] Recuperação após restart; detecção de corrupção; lock por campanha
- [x] `@anthropic-ai/sdk` + `AnthropicLlmClient` (streaming, saída estruturada, usage, request id, modelo servido, mapeamento de erros, redação da key)
- [x] Prompt `campaign-plan@1.0.0` de produção (análise completa, hooks distintos, conceitos, cenas, estratégia híbrida, compliance)
- [x] `runStructuredPrompt`: parse → Zod → retry limitado; todas as tentativas registradas
- [x] `LlmCreativePlanner` + `LLM_PROVIDER=mock|anthropic`
- [x] `evaluatePlanAgainstPreset` + ajuste determinístico `fitPlanToPreset`
- [x] Custo real do Claude no ledger; estimativa incorrido × futuro × projetado
- [x] Script `npm run plan:real` (validação manual, exige `--confirm`) e suíte de integração paga separada
- [ ] Validação manual real com `ANTHROPIC_API_KEY` — **pendente: chave não disponível nesta sessão**

## Lote 2 — UI `/create` (próximo, aguarda autorização)
- [ ] Formulário de produto, upload de imagens para `outputs/uploads`
- [ ] Telas: análise, hooks, conceitos, roteiros, cenas, prompts, avaliação do preset/ajustes
- [ ] Estimativa: "já incorrido" × "futuro estimado"; botão "Gerar por ~R$X"
- [ ] Diálogo `BUDGET_EXCEEDED` (Cancelar / Autorizar exceder)
- [ ] Server Actions finas chamando `PipelineService` (singleton por processo)
- [ ] Planejamento em background (chamadas de minutos não devem segurar a request)

## Lote 3 — Renderização com Remotion
- [ ] Composição 1080x1920 e componentes (captions, headline, CTA, progress, nome, preço, cenas de vídeo/imagem, transições)
- [ ] `RemotionRenderer`; assets placeholder locais para os mocks; `screenshot`/`existing_asset` reais

## Lote 4 — Áudio real (ex.: ElevenLabs)
## Lote 5 — Primeiro provider de vídeo real (ex.: Veo/Runway/Kling)

## Dívida técnica
- Sem transação entre arquivos (custo pode ser gravado e o estado do job não, se o processo cair entre as duas escritas). Migrar para SQLite quando houver worker/UI concorrente.
- Um único processo por `DATA_DIR` (o lock é só dentro do processo).
- `listJobs` lê arquivos um a um (ok para uso local).
- Estimativa de tokens de entrada para o pior caso é heurística (caracteres/3 × 2).
- `fitPlanToPreset` reduz segundos de clipe sem reescrever narração/prompt da cena; o render precisará preencher o restante com movimento.
- O enum dos campos (ex.: `shotType`) vai na descrição do JSON Schema (comportamento do helper do SDK); a validação Zod cobre, mas uma violação custa uma tentativa.
- Fallbacks server-side da Anthropic não habilitados (decisão de custo); recusa vira erro tipado.
- Re-estimativa após falha recalcula o criativo inteiro; mocks retornam URIs `mock://`; cotação estática.
- Prompt `campaign-plan@1.0.0` ainda não foi avaliado com o modelo real (falta a validação manual).
