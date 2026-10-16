# AI UGC

Modo "AI UGC" (Lote 5.3): foto real do produto → pessoa sintética segurando/apresentando o produto → storyboard → vídeo falado → cenas complementares → render. Hoje tudo é MOCK; os contratos Google estão preparados sem transporte (D79–D85).

## Fluxo na interface
1. `/create` → Tipo de vídeo **AI UGC**; envie ao menos uma foto do produto.
2. Escolha preset (Econômico/Equilibrado/Premium), apresentador (automático/mulher/homem) e ambiente.
3. Revise o storyboard (quem aparece, o que segura, o que fala, o que faz) e o custo.
4. "Gerar vídeo por até R$ X" autoriza o job inteiro. A primeira etapa gera a referência e **pausa**.
5. "Esta será a pessoa apresentando seu produto": Aprovar, Gerar outra, Trocar apresentador/ambiente ou Editar conceito.
6. Após aprovar, o job continua no mesmo teto: cenas UGC → B-roll/imagens → render.

## Arquitetura Google preparada (REAL desligado)

- Referência: `UgcReferenceProviderGoogle` + `gemini-3.1-flash-image` (Nano Banana 2), edição text+image→image 1K/9:16. A imagem original entra como dado, com instrução explícita para preservar formato, cores, logo, embalagem e proporções.
- Vídeo: `UgcVideoProviderVeo`, candidatos `veo-3.1-lite-generate-preview`, `veo-3.1-fast-generate-preview` e `veo-3.1-generate-preview`.
- Econômico = Lite 720p; Equilibrado = Fast 720p; Premium = Fast 1080p, com Standard 1080p disponível na configuração pura.
- Veo: 4/6/8s; 1080p e uso de `referenceImages` pedem 8s. Lite usa a referência UGC já composta como `image`; Fast/Standard podem acrescentar produto original e outras referências, até três.
- `seed` é aceito no contrato quando suportado, mas fica registrado como não determinístico.
- Builders, polling, timeout, download e adapters existem sem transporte de produção. A factory REAL continua lançando indisponibilidade; não existe chave Google nem botão habilitado.

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

Implementar e auditar os transportes HTTP oficiais, resolver URI local para bytes/inlineData, adicionar credencial Google somente no servidor, confirmar política de pessoas/uso comercial, mapear usage/cobrança e CDN reais, criar preflight/capability opt-in e validar manualmente UMA referência + UMA cena curta com nova autorização. Ver [TASKS.md](TASKS.md).
