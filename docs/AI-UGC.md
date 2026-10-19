# AI UGC

Modo "AI UGC" (Lote 5.3): foto real do produto → pessoa sintética segurando/apresentando o produto → storyboard → vídeo falado → cenas complementares → render. MOCK por padrão; transporte REAL Google implementado no Lote 5.4 e DESLIGADO até opt-in explícito (D79–D87). Nenhuma chamada real foi executada.

## Fluxo na interface
1. `/create` → Tipo de vídeo **AI UGC**; envie ao menos uma foto do produto.
2. Escolha preset (Econômico/Equilibrado/Premium), apresentador (automático/mulher/homem) e ambiente.
3. Revise o storyboard (quem aparece, o que segura, o que fala, o que faz) e o custo.
4. "Gerar vídeo por até R$ X" autoriza o job inteiro. A primeira etapa gera a referência e **pausa**.
5. "Esta será a pessoa apresentando seu produto": Aprovar, Gerar outra, Trocar apresentador/ambiente ou Editar conceito.
6. Após aprovar, o job continua no mesmo teto: cenas UGC → B-roll/imagens → render.

## Arquitetura Google (REAL opt-in, Lote 5.4)

- Referência: `UgcReferenceProviderGoogle` + `gemini-3.1-flash-image` (Nano Banana 2), edição text+image→image 1K/9:16. A imagem original entra como dado, com instrução explícita para preservar formato, cores, logo, embalagem e proporções.
- Vídeo: `UgcVideoProviderVeo`, candidatos `veo-3.1-lite-generate-preview`, `veo-3.1-fast-generate-preview` e `veo-3.1-generate-preview`.
- Econômico = Lite 720p; Equilibrado = Fast 720p; Premium = Fast 1080p, com Standard 1080p disponível na configuração pura.
- Veo: 4/6/8s; 1080p e uso de `referenceImages` pedem 8s. Lite usa a referência UGC já composta como `image`; Fast/Standard podem acrescentar produto original e outras referências, até três.
- `seed` é aceito no contrato quando suportado, mas fica registrado como não determinístico.
- Transporte: `providers/ugc/google-http.ts` (HTTP sanitizado, erros A/B/C) e `google-transports.ts` (Gemini `generateContent`, Veo `predictLongRunning` + polling + download). A factory só cria providers REAL com o preflight Google completo.
- Habilitar (só servidor, `.env.local`): `GOOGLE_AI_API_KEY`, `UGC_PROVIDER=google`, `UGC_REAL_ALLOWED=true`. A chave sozinha não habilita. Na UI: "Gerando apresentador com seu produto..." → "Esta será a pessoa apresentando seu produto" (Aprovar / Gerar outra) → "Gerando cena UGC...".

## Provider Krea (REAL opt-in, auditado sem chamada)

- Referência: `POST /assets` da foto original → persistência local do asset → `POST /generate/image/google/nano-banana-2` em 1K/9:16 → `GET /jobs/{id}` → primeiro item de `result.urls`.
- Antes do POST pago ficam persistidos SHA-256 da foto, UUID e URL do asset, provider, timestamp, job, versão, modelo, teto e custo. Em restart antes do envio pago, `GET /assets/{id}` confirma o asset para reuso. A Krea não documenta prazo fixo de validade; por isso o sistema nunca presume validade sem essa consulta.
- Vídeo preparado: `POST /generate/video/google/veo-3.1-fast`, 720p em Econômico/Equilibrado e 1080p em Premium, 4/6/8s faturáveis, 9:16, `generate_audio=true`; referência aprovada obrigatória e sem ElevenLabs/segunda voz. Não executar antes de aprovar a referência real.
- Readiness: `KREA_API_KEY` + `UGC_PROVIDER=krea` + `UGC_REAL_ALLOWED=true` + modelos e pricing oficiais válidos. A chave sozinha não habilita.
- Dry-run da primeira referência: `npm run ugc:reference:real -- --image "C:/fotos/produto.jpg"`. Com a configuração Krea acima, mostra Nano Banana 2/US$0,08 e faz zero rede/escrita.
- Primeira referência real futura: acrescente `--confirm`; faz um upload quando necessário e exatamente uma tentativa de geração. Nenhum vídeo é chamado.

Fontes consultadas em 2026-10-16: documentação oficial Krea de [upload/get de assets](https://www.krea.ai/docs/api-reference/assets/upload-an-asset), [jobs](https://www.krea.ai/docs/developers/job-lifecycle), [Nano Banana 2](https://www.krea.ai/docs/api-reference/image/nano-banana-2) e [Veo 3.1 Fast](https://www.krea.ai/docs/api-reference/video/veo-31-fast).

## Protocolo da primeira validação real (NÃO executado)

1. Teste A — dry-run: `npm run ugc:reference:real -- --image "C:/fotos/produto.jpg"` (sem rede; mostra modelo, custo US$0,067, entradas e readiness).
2. Teste A — real: o mesmo comando com `--confirm`: exatamente UMA referência; imprime a intenção `ugcref_…`.
3. Revisão visual do PNG salvo; se correto: `npm run ugc:reference:real -- --approve <id>`.
4. Teste B — dry-run e depois `npm run ugc:video:real -- --reference <id> --confirm`: UMA cena Veo Fast, 8s, 720p, 9:16, áudio nativo (US$0,80). Polling expirado: `--resume <id> --confirm`, sem novo POST.
5. Não gerar anúncio inteiro nesta fase.

## Pricing

Fonte: https://ai.google.dev/gemini-api/docs/pricing, consultada em 2026-10-16. Valores em `src/config/pricing.ts`: Lite 720p US$0,05/s; Lite 1080p US$0,08/s; Fast 720p US$0,10/s; Fast 1080p US$0,12/s; Standard 720p/1080p US$0,40/s. A referência 1K reserva US$0,067 de saída; o transporte futuro deverá registrar também o usage real de entrada/texto.

## Regras
- Nenhuma cena UGC sem referência aprovada da identidade atual.
- Mesma pessoa, figurino, ambiente e produto em todas as cenas; trocar identidade depois de existir cena UGC é recusado.
- Fala de criador; proibido "uso há meses", "testei", "funcionou comigo", "comprei", depoimentos e jargão.
- Veo usa `native_speech`: pula ElevenLabs, desmuta somente o clipe e o encoder preserva seu AAC. Providers futuros podem usar `external_lipsync` como rota separada. Nunca as duas vozes.
- Sem retry pago automático; cobrança incerta pausa; ledger append-only com categorias referência UGC, cena UGC, B-roll, voz e render.
- Antes do submit real, persiste intenção. Depois, persiste operation ID. Reinício retoma polling/download pelo ID; intenção sem ID ou cobrança incerta bloqueia reenvio.

## Variáveis
- `UGC_DIR` (default `outputs/ugc`): referências reais versionadas.
- `UGC_MOCK_AUDIO_STRATEGY` (`native_speech` | `external_lipsync`): estratégia do mock.

## Falta para o real

Executar o protocolo acima com instrução explícita, confirmar no primeiro uso o formato REST efetivo do Veo (`durationSeconds`, `inlineData`), o redirect de download e o usage/cobrança reais, e revisar política de pessoas/uso comercial. Ver [TASKS.md](TASKS.md).

## Creative Editor V2 (Lote 5.6)

UGC é editado como narrativa contínua, não concatenação de cenas independentes. A-rolls (ugc_*) formam a espinha de áudio; B-rolls `reference_detail` (recorte do frame aprovado, custo zero) cobrem as junções enquanto o áudio da apresentadora continua. A referência agora é pedida como frame real de UGC (sem texto, slogan, números inventados ou layout de anúncio) e os prompts de vídeo pedem realismo de smartphone, continuidade da cena anterior e fidelidade do produto. Antes das cenas, confirme na interface: "Verifique se produto, logo, textos e especificações continuam fiéis." Se algum texto ou número divergir (ex.: 3900 no lugar de 2100W), informe-o: a referência fica em revisão e nenhuma cena é gerada. Detalhes em D91.
