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

## Lote 2 — Experiência de criação `/create` ✅
- [x] `/create` em etapas (Produto → Estratégia) com stepper; rascunho local no navegador (restaurar/descartar)
- [x] Produto: nome, link, descrição, características/benefícios (listas editáveis), preço, público, observações
- [x] Upload local de imagens em `outputs/uploads/{productId}/` (JPG/PNG/WebP, 8 MB, 6 por produto; tipo detectado pelos bytes; nome gerado; anti path traversal; preview e remoção)
- [x] Estratégia: 1/2/3/5 criativos; AUTO ou formatos específicos; cards dos presets com números do sistema de custos; limites de orçamento editáveis + "permitir autorizar exceder"
- [x] Planejamento em background no próprio processo (`startPlanning`), polling da página, estado "interrompido" após restart e retomada explícita (`retryPlanning`)
- [x] Revisão em `/campaigns/[id]`: análise, hooks (copiar), conceitos, criativos, cenas com tipo visual, prompts recolhidos, ajuste do preset ("Plano otimizado…")
- [x] Custo: já utilizado (real) × futuro estimado × total projetado, por criativo e da campanha; "Estimativa provisória" para preços placeholder
- [x] Aprovação por criativo ("Gerar por aproximadamente R$X") em MODO DE TESTE com providers mock; cancelar criativo
- [x] Diálogo BUDGET_EXCEEDED (Cancelar / Autorizar até R$X só quando o domínio permite), na aprovação e durante a geração
- [x] Estados de erro: formulário, Claude não configurado, falha, rate limit, timeout, resposta inválida, resposta cortada, corrompido, orçamento, interrompido
- [x] Home com CTA e campanhas recentes; `/campaigns` com histórico mínimo
- [x] Camada `application/` (form, view model, apresentação de custos, erros, casos de uso) + Server Actions finas
- [ ] **Validação manual real do prompt `campaign-plan@1.0.0` com `ANTHROPIC_API_KEY`** — pendente: a chave não estava disponível nesta sessão (ver "Etapa 0" abaixo)

### Etapa 0 — validação real (pendente)
Com a chave em `.env.local`, rodar **uma** vez:
```bash
npm run plan:real              # mostra o pior caso, não chama nada
npm run plan:real -- --confirm # UMA validação real
```
Registrar: modelo servido, tokens, custo real, duração, resultado do schema, nº de hooks e conceitos, duração dos criativos, segundos de IA e ajustes de `fitPlanToPreset`. Correção de prompt, se necessária, deve ser mínima e virar `campaign-plan@1.0.1` (documentada em DECISIONS).

## Roadmap (próximos lotes — não iniciar sem autorização)

### Lote 3 — Renderização com Remotion
- [ ] Composição 1080x1920 e componentes (captions, headline, CTA, progress, nome, preço, cenas de vídeo/imagem, transições)
- [ ] `RemotionRenderer`; assets placeholder locais para os mocks; `screenshot`/`existing_asset` reais

### Lote 4 — Áudio real (ex.: ElevenLabs)
- [ ] `AudioProvider` real + preço oficial (remove o placeholder de áudio)

### Lote 5 — Primeiro provider de vídeo real (ex.: Veo/Runway/Kling)
- [ ] `VideoProvider` real + preço oficial; geração fora da request HTTP (worker/fila local)

### Lote 6 — Operação em escala
- [ ] Campanhas em volume, fila de execução, persistência mais robusta (SQLite) quando necessária, múltiplos processos

### Lote 7 — Performance e vendas
- [ ] Métricas de performance, vendas, comissão, ROI e geração de variações dos criativos vencedores

## Dívida técnica
- Sem transação entre arquivos (custo pode ser gravado e o estado do job não, se o processo cair entre as duas escritas). Migrar para SQLite quando houver worker/UI concorrente.
- Um único processo por `DATA_DIR` (o lock e o registro de planejamentos em execução são só do processo).
- Planejamento roda dentro do processo do Next (não é fila durável). Se o processo cair, a campanha fica "interrompida" e a chamada já feita ao Claude pode ter sido cobrada sem registro no ledger (o `usage` só chega no fim).
- Geração de mídia (mock) ainda roda dentro da Server Action; com providers reais precisa ir para background (Lote 5).
- `listJobs` lê arquivos um a um; `/campaigns` lê todas as campanhas e o ledger a cada request (ok para uso local).
- Estimativa de tokens de entrada para o pior caso é heurística (caracteres/3 × 2).
- `fitPlanToPreset` reduz segundos de clipe sem reescrever narração/prompt da cena; o render precisará preencher o restante com movimento.
- O enum dos campos (ex.: `shotType`) vai na descrição do JSON Schema (comportamento do helper do SDK); a validação Zod cobre, mas uma violação custa uma tentativa.
- Fallbacks server-side da Anthropic não habilitados (decisão de custo); recusa vira erro tipado.
- Re-estimativa após falha recalcula o criativo inteiro; mocks retornam URIs `mock://`; cotação estática.
- Prompt `campaign-plan@1.0.0` ainda não foi avaliado com o modelo real (falta a validação manual).
- AUTO envia todos os formatos ao prompt sem instrução extra de "escolha os melhores" (evita mudar o prompt antes da validação real).
- Uploads órfãos (imagens enviadas sem campanha planejada) não são limpos automaticamente.
- Sem testes de componentes React (só lógica em `application/`); o fluxo visual foi verificado manualmente.
