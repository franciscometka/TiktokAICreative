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
- [x] Validação manual real com o Claude (2026-10-14): válida na 1ª tentativa, US$0,0414 — resultados na seção do Lote 2

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
- [x] **Validação manual real do prompt `campaign-plan@1.0.0`** (Lote 1) — concluída em 2026-10-14, ver abaixo

### Validação manual real do Lote 1 ✅ (2026-10-14)
Uma execução de `npm run plan:real -- --confirm` (nenhuma outra chamada à Anthropic):

| Item | Resultado |
|---|---|
| Preset | economy |
| Modelo servido | `claude-sonnet-5-5` (esforço medium) |
| Criativos | 1 |
| Tentativas | 1 — válido na primeira tentativa (JSON + Zod) |
| Tokens | entrada 613 · saída 2.801 · escrita de cache 4.867 |
| Duração | 25,5s |
| Custo real do Claude | US$0,0414 (≈ R$0,23) |
| Duração final planejada | 24s |
| Vídeo IA | 9s (permitido 8–12s) |
| Ajustes de `fitPlanToPreset` | nenhum |
| Custo futuro estimado | R$4,05 |
| Total projetado | R$4,28 |
| Preços de mídia | ainda provisórios (`unassigned-*`) |

Conclusão: o prompt `campaign-plan@1.0.0` funciona estruturalmente (schema, limites do preset, custos). A revisão do conteúdo gerou duas regras novas de honestidade (DECISIONS D42; SPEC "Regras de conteúdo"), a aplicar no prompt antes de qualquer mídia real.

## Lote 3 — Renderização real com Remotion ✅
- [x] Remotion 4.0.531 (versões fixas), composição `TikTokCreative` 1080x1920 @30fps, duração vinda do manifest (`calculateMetadata`)
- [x] Timing puro em frames sem erro acumulado (`render/timeline.ts`)
- [x] `VisualSource` → estratégia (`scene-strategy.ts`), placeholder "MOCK · VÍDEO IA" para vídeo IA mock
- [x] `AssetResolver` (raízes autorizadas, anti traversal, conteúdo conferido) + servidor de assets efêmero em 127.0.0.1
- [x] Imagem real com movimento leve, cover/contain sem distorção; legendas da narração; hook; CTA com nome/preço uma vez
- [x] Safe areas e tokens de tema; Inter local (render offline); transições cut-first que não mudam a duração
- [x] `RemotionRenderer` + `createRenderer` (`RENDERER=mock|remotion`), H.264 yuv420p bt709, sem áudio
- [x] Versões `v<N>` sem sobrescrever + `manifest.json`; render em background em 3 fases sem lock; `RenderRecord` persistido
- [x] Progresso real de frames; interrompido derivado, retomada explícita; `completed/failed → rendering`
- [x] UI: etapas do render, player 9:16, Assistir / Baixar MP4 / Renderizar novamente, versões anteriores, avisos, custo R$0,00 (local)
- [x] Rota `/api/renders/...` por IDs (Range, nosniff, Content-Disposition)
- [x] Testes unitários (timing, captions, estratégia, resolver/traversal, props, safe areas, caminhos/versões, factory, fluxo de render, download) + `npm run test:render` (MP4 real de 3s)

### Validação manual do Lote 3 ✅ (2026-10-14)
`LLM_PROVIDER=mock`, `RENDERER=remotion`, preset econômico, 1 criativo, imagem real enviada pelo wizard (PNG 900x1200). Nenhuma chamada à Anthropic nem a providers de vídeo/áudio.
- v1: 25s, 750 frames, 1080x1920, H.264, 2,1 MB, 81,4s de render (inclui o empacotamento do 1º render do processo).
- "Renderizar novamente" → servidor parado no meio → página mostra "Interrompido", nada recomeça; retomada explícita → v3 (v2 ficou vazia e foi pulada): 2,6 MB, 119,9s. v1 continua acessível em "Versões anteriores".
- Player (`Range` 206), download (`attachment`), avisos (3 cenas de IA em placeholder + sem áudio). Layout conferido em 1440, 768 e 375 px sem rolagem horizontal.
- Frames inspecionados: hook, placeholder marcado, imagem sem distorção, legendas legíveis, CTA com nome/preço uma vez, tudo dentro das safe areas.

## Lote 4 — Narração real com ElevenLabs ✅
- [x] Prompt `campaign-plan@1.0.1` (regras da D42), ativo; sem chamada à Anthropic (D65)
- [x] `ElevenLabsAudioProvider` isolado (`/with-timestamps`, sem SDK, sem retry), `AUDIO_PROVIDER=mock|elevenlabs`, `ELEVENLABS_API_KEY` só no servidor (D56)
- [x] Modelos por preset em `config/tts-models.ts` (Flash v2.5 / Multilingual v2) e preço OFICIAL em `pricing.ts` (D57)
- [x] `SpeakerProfile` + 4 vozes pt-BR com nomes amigáveis; escolha no wizard (D58)
- [x] Narração contínua por criativo (D55) com texto falado normalizado pt-BR ligado ao texto escrito (D59)
- [x] Timing real → `TimedWord` → `TimedCaption`; legendas sincronizadas; fallback estimado com aviso (D60)
- [x] AudioFit + estado `audio_review` (aceitar / gerar de novo / cancelar); extensão local do fim (D61)
- [x] Custo estimado antes, custo real + request id no ledger depois; regeneração explícita com orçamento e limite (D62)
- [x] Áudio versionado em `outputs/audio/...` (mp3 + timing + metadata), rota `/api/audio/...` por IDs (D63)
- [x] Remotion com `<Audio>` → MP4 com AAC; sem áudio continua como no Lote 3 (D64)
- [x] UI: voz, provider ("MODO DE TESTE" / "Narração real · ElevenLabs"), custo estimado × real, status, encaixe, player, gerar de novo
- [x] Testes: provider com transporte falso, config/modelos, SpeakerProfile, pricing, usage/request id, erros, timestamps, alinhamento → palavras → legendas, pt-BR/pontuação, "R$ 79,90", AudioFit, orçamento, sem retry pago, ledger, versionamento, traversal, Remotion com e sem áudio, mock; `npm test` com rede bloqueada (D66)
- [x] `npm run tts:real` (sem `--confirm` não chama; com `--confirm`, UMA chamada curta)
- [x] `npm run test:render` com fixture WAV local: MP4 com trilha AAC sem usar ElevenLabs

### Validação real do Lote 4 ✅ (2026-10-14)
UMA chamada real (`npm run tts:real -- --confirm`), sem retentativa:

| Item | Resultado |
|---|---|
| Modelo / voz | `eleven_flash_v2_5` · Clara → "Sarah" |
| Caracteres enviados | 169 |
| `character-cost` (créditos) | 85 |
| Request id | `IxjNGD1yOudqif0Kw02v` |
| Duração do áudio / fim da fala | 10,658s / 10,589s |
| Latência | 1.215 ms |
| AudioFit (alvo 9s) | `too_long` |
| Alinhamento / legendas / MP3 | válidos / válidas / salvo |
| Custo monetário (tabela da API) | 169 × US$0,05/1000 = US$0,00845 |

Correções depois da validação: `character-cost` separado de caracteres enviados e de custo (D67); preço vigente da API US$0,05 / US$0,10 (D57).

## Roadmap (próximos lotes — não iniciar sem autorização)

### Lote 5 — Primeiro provider de vídeo real (ex.: Veo/Runway/Kling)
- [x] Runway Gen-4 Turbo modular, configuração opt-in, preço oficial e estimativa pela duração comprada
- [x] Aprovação/orçamento/limite existentes; task id persistido; sem retry pago
- [x] Clipe local versionado, ledger antes de salvar, consumo preservado em falha de download/disco; vídeo real no Remotion
- [x] `npm run video:real` com dry-run e `--confirm` explícito para uma cena de 5s via pipeline
- [x] Testes com transporte falso, offline, incluindo persistência, versões e falhas cobradas
- [ ] Primeira validação real autorizada (chave, qualidade, CDN e composição final) — não executada neste lote
- [ ] Upload de `screenshot`/`existing_asset` (hoje caem para imagem do produto/card de texto)

Validação offline do Lote 5 (2026-10-14): `npm run check` aprovado (451 testes / 40 arquivos, lint e TypeScript), `npm run build` aprovado. Inclui `video:real` em dry-run e com `--confirm` usando transporte integralmente falso; nenhuma chamada real/paga e nenhum push.

### Lote 6 — Operação em escala
- [ ] Campanhas em volume, fila de execução, persistência mais robusta (SQLite) quando necessária, múltiplos processos

### Lote 7 — Performance e vendas
- [ ] Métricas de performance, vendas, comissão, ROI e geração de variações dos criativos vencedores

## Dívida técnica
- Sem transação entre arquivos (custo pode ser gravado e o estado do job não, se o processo cair entre as duas escritas). Migrar para SQLite quando houver worker/UI concorrente.
- Um único processo por `DATA_DIR` (o lock e o registro de planejamentos em execução são só do processo).
- Planejamento roda dentro do processo do Next (não é fila durável). Se o processo cair, a campanha fica "interrompida" e a chamada já feita ao Claude pode ter sido cobrada sem registro no ledger (o `usage` só chega no fim).
- Geração e render rodam em background DENTRO do processo do Next (não é fila durável); se o processo cair, o job aparece como interrompido e só retoma com ação explícita.
- Bundle do Remotion em cache na memória do processo: mudanças em `remotion/` exigem reiniciar o servidor.
- Render interrompido pode deixar uma pasta de versão vazia (pulada na próxima versão); renders antigos não são limpos automaticamente.
- Progresso de render só em memória (some num restart; o estado persistido é o `RenderRecord`). Durante a codificação final a barra fica em 100% dos frames até o MP4 ficar pronto.
- Windows + projeto em pasta funda: Chrome do Remotion pode exceder MAX_PATH (usar `RENDER_BROWSER_EXECUTABLE`).
- `npm run test:render` deixa os MP4 de teste em `outputs/.test-render/` (ignorado pelo git) para inspeção.
- `listJobs` lê arquivos um a um; `/campaigns` lê todas as campanhas e o ledger a cada request (ok para uso local).
- Estimativa de tokens de entrada para o pior caso é heurística (caracteres/3 × 2).
- `fitPlanToPreset` reduz segundos de clipe sem reescrever narração/prompt da cena; o render precisará preencher o restante com movimento.
- O enum dos campos (ex.: `shotType`) vai na descrição do JSON Schema (comportamento do helper do SDK); a validação Zod cobre, mas uma violação custa uma tentativa.
- Fallbacks server-side da Anthropic não habilitados (decisão de custo); recusa vira erro tipado.
- Re-estimativa após falha recalcula o criativo inteiro; mocks retornam URIs `mock://`; cotação estática.
- Prompt `campaign-plan@1.0.0` validado só com 1 criativo no preset economy; high/premium e vários criativos ainda não foram testados com o modelo real.
- `campaign-plan@1.0.1` ainda não validado com o Claude real (só testes do texto do prompt).
- ElevenLabs validada com UMA chamada real curta (preset economy); Multilingual v2 e criativos completos ainda não testados em chamada real.
- Vozes são premade multilíngues (sotaque pode não ser brasileiro nativo); trocar por vozes pt-BR da Voice Library.
- Timeout de TTS: a chamada pode ter sido cobrada sem registro (não sabemos o `usage`); a mensagem avisa e nada é re-tentado.
- Preço de API (USD) ≠ créditos/quota da assinatura (`character-cost`); o ledger usa só o preço de API. Se a conta for por assinatura, o gasto real em dinheiro depende do plano.
- Regenerar narração refaz o criativo inteiro (narração contínua, D55); não há regeneração parcial por cena.
- Normalização pt-BR cobre dinheiro, números, unidades comuns e %; datas, horas "10:30", siglas e números ordinais seguem como escritos.
- Legendas são cortadas quando o CTA entra (mesma faixa da tela), mesmo com a fala continuando.
- Narração não é refeita quando o plano muda depois da geração (exige nova estimativa/aprovação, como antes).
- AUTO envia todos os formatos ao prompt sem instrução extra de "escolha os melhores" (pode entrar junto com a `1.0.1`).
- Uploads órfãos (imagens enviadas sem campanha planejada) não são limpos automaticamente.
- Sem testes de componentes React (só lógica em `application/`); o fluxo visual foi verificado manualmente.
- Integridade de duração: a tolerância (max 0,25s; 5%) ainda não foi calibrada com vários clipes reais; MP4 com `moov` no fim não é reescrito para faststart (o player do browser precisa de Range para tocar).


### Presenter/avatar real — implementação de 2026-10-15
- [x] Provider independente para Avatar Videos/gwm1_avatars com áudio existente, sem TTS Runway
- [x] Alignment → janela → WAV PCM local → envio, polling, task durável, retomada explícita sem POST duplicado
- [x] Aprovação/orçamento/ledger/versionamento/integridade preservados; IDs e custos auditáveis
- [x] Avatar selecionável, painel de status/custo/preview e regeneração explícita
- [x] CLI presenter:real com dry-run e validação isolada de uma chamada; origem preservada
- [x] Product UGC: contrato local com consentimento, imagens, informações/script e audio=false; geração desabilitada
- [ ] Primeira validação paga de presenter autorizada (nenhuma feita na implementação)
- [ ] Product UGC real e estratégia de fala sincronizada: verificar rota compatível antes de habilitar

## Modo híbrido por etapa (2026-10-15)

- [x] Seletores MOCK/REAL independentes para planejamento, narração, vídeo, avatar e render; REAL só com provider configurado.
- [x] Planejamento real em draft, cotação de pior caso e aprovação explícita; sem retry pago automático.
- [x] Painel de provider/modelo/estado/custo real e simulado/bloqueio/execução por etapa.
- [x] Uma unidade paga por clique; nenhuma cascata paga; escopo de transporte limitado.
- [x] Aprovação por cotação, orçamento sob lock, autorização de excedentes por escopo, histórico de aprovação.
- [x] Troca de modo sem apagar assets; nova versão explícita; limite de tentativas mantido.
- [x] Retomada de vídeo/avatar pelo ID, sem novo POST; intenção sem ID bloqueia reenvio.
- [x] Preservados ledger, diagnóstico HTTP, duração medida e integridade dos clipes reais.
- [x] Jobs offline de ff176bb adotam modos no próprio job sem apagar histórico; projetos reais antigos ficam consultáveis e podem ser copiados.
- [ ] Validação REAL paga integrada, incluindo primeira validação do presenter (não autorizada nesta implementação).

Guia: [HYBRID-WORKFLOW.md](HYBRID-WORKFLOW.md).

## Lote 5.1 — Fechamento ponta a ponta pela interface ✅
- [x] Diagnóstico sanitizado de Anthropic, ElevenLabs, Runway, providers selecionados, renderer e navegador Remotion
- [x] Configuração inválida mantém UI acessível em fallback MOCK e mostra correção orientada
- [x] Configuração pública reflete o runtime em vez de valores hardcoded MOCK
- [x] Preflight local por cotação: provider, assets, dependências, duração, tentativas, orçamento e aprovação
- [x] Rechecagem sob lock imediatamente antes da autorização efêmera de uma unidade
- [x] "Próxima etapa recomendada" derivada do estado/cotações do job
- [x] Detecção do navegador sem download + `npm run render:check`; instalação somente por `render:setup`
- [x] Fluxo completo por botões em MOCK e protocolo completo com transportes falsos
- [x] Protocolo futuro limitado a 1 narração, 1 avatar, 1 cena de produto e 1 render local
- [ ] Validação integrada REAL/paga — exige autorização futura
- [ ] Product UGC real — fora de escopo

## Redesign do fluxo utilizável ✅
- [x] Produto simplificado: nome, imagens, descrição curta opcional e enriquecimento local sem claims
- [x] Presets Econômico 15–20s, Equilibrado 20–30s e Premium 30–45s sem migrar campanhas antigas
- [x] Apresentador simples: mulher, homem ou nenhum; mapeamento técnico interno
- [x] Storyboard completo com timeline, fala, visual, referência, tipo e status de todas as cenas
- [x] Edição de cena e nova ideia MOCK antes da mídia, com nova estimativa
- [x] Cotação e autorização única persistente para o job inteiro
- [x] Pipeline automático narração → avatar → cenas → render, com pausa em falha/aumento/incerteza
- [x] Preview de asset real por cena e resultado final; MOCK deixa explícito que não há MP4
- [x] Providers, modelos, ledger, tentativas, versões, diagnóstico e durações em detalhes recolhidos
- [x] Testes offline do fluxo automático com mocks e transportes falsos; nenhuma chamada paga
- [ ] AI UGC/Veo real — próximo lote; domínio continua preparado


## Lote 5.3 — AI UGC (MOCK completo) ✅
- [x] Modo criativo "AI UGC" no fluxo simples: produto, imagens, preset, apresentador (auto/mulher/homem), ambiente (auto/escolhido)
- [x] Etapa "Referência UGC" persistida e versionada (pessoa + produto 9:16, produto-âncora preservado)
- [x] Aprovação visual com Aprovar / Gerar outra / Trocar apresentador / Trocar ambiente / Editar conceito
- [x] Nenhuma cena UGC sem referência aprovada; pausa e retomada sob a mesma autorização do job
- [x] `UgcReferenceProvider` e `UgcVideoProvider` separados do Presenter; mocks completos
- [x] Cenas ugc_hook/ugc_demo/ugc_benefit/ugc_cta + product_broll; presets com mix diferente
- [x] Identidade persistida por job + consistência por tentativa; schema de biblioteca futura
- [x] Estratégias de áudio native_speech / external_lipsync, sem áudio duplicado
- [x] Fala UGC natural validada (sem experiência inventada, cabe na duração); prompt 1.5.0
- [x] Storyboard: quem aparece / o que segura / o que fala / o que faz
- [x] Categorias de custo referência UGC, cena UGC, B-roll; preços placeholder
- [x] Contratos atualizados: Nano Banana `gemini-3.1-flash-image` + Veo 3.1 Lite/Fast/Standard, sem transporte nem rede
- [x] Pricing oficial Veo isolado por modelo/resolução; presets Econômico Lite 720p, Equilibrado Fast 720p e Premium Fast 1080p (Standard configurável)
- [x] Intenção/operação UGC durável antes/depois do submit; retomada por operation ID, timeout sem reenvio e custo deduplicado
- [x] Áudio nativo Veo preservado no Remotion sem ElevenLabs/narração duplicada
- [x] Testes offline: referência, aprovação, bloqueio, consistência, cenas, storyboard, presets, orçamento, retomada, regeneração, pipeline MOCK, separação Presenter × UGC, nenhuma chamada fora da autorização

### Falta para a primeira geração UGC real
- [x] Escolher modelos oficiais candidatos (Gemini image generation/Nano Banana + Veo 3.1; nunca Flow web)
- [x] Preços oficiais Veo e referência 1K com fonte/data em `config/pricing.ts`
- [ ] Implementar transportes HTTP reais de referência e vídeo sobre os contratos já preparados
- [ ] Política de geração de pessoas (pessoa sintética, sem semelhança com reais) e consentimento para biblioteca
- [ ] Resolver de asset para enviar a imagem de referência aprovada ao provider
- [ ] Habilitar capabilities REAL de `ugc_reference`/`ugc_video` com credencial configurada
- [ ] Script de validação manual com `--confirm` (UMA referência + UMA cena curta)
