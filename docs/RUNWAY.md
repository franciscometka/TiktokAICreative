# Primeira validação Runway

Implementado sem chamadas reais ou pagas. Preços: https://docs.dev.runwayml.com/guides/pricing/; contrato HTTP: https://github.com/runwayml/sdk-node/tree/main/src/resources.

1. Em `.env.local`, defina `RUNWAYML_API_SECRET` (não commitar). Use foto JPG/PNG/WebP pequena: até 5 MB depois de base64 (~3,7 MB original).
2. Rode `npm run video:real -- --image "C:/fotos/produto.jpg"`. Deve informar Gen-4 Turbo, 5 segundos, 25 créditos, US$0,25, sem chamadas/gravações. Não precisa de chave para isso.
3. Somente quando quiser autorizar a cobrança, acrescente `--confirm`. Faz UMA geração via aprovação e orçamento do pipeline. Não há retry automático. Os limites de orçamento do ambiente continuam valendo.
4. Anote campanha/job impressos. Confira job em DATA_DIR, ledger e clipe em VIDEOS_DIR/campanha/cena/vN. Avalie fidelidade do produto, rótulo e movimento. Confirme consumo na conta Runway. Erro após envio pode ter cobrança: consulte a tarefa antes de repetir.
5. Para validar o criativo completo, defina `VIDEO_PROVIDER=runway` e `RENDERER=remotion`, reinicie o servidor, crie NOVA campanha e revise plano/estimativa antes de aprovar. Cada cena IA dessa campanha é uma chamada paga separada; o comando manual limita-se a uma. Áudio real só se AUDIO_PROVIDER=elevenlabs e sua cobrança também for aprovada pelo fluxo.

Clipe gerado: 720x1280; saída final Remotion: 1080x1920. Duração comprada conservadora de 5/10s, mesmo que o plano use menos segundos. Cenas acima de 10s exigem revisão, não são divididas em chamadas automaticamente. Planos antigos de outro modelo são recusados pela factory real; não se troca o preço de uma aprovação existente.

Sem validação real ainda: autenticação/créditos da conta, CDN retornada pela API, qualidade visual e MP4 final com clipes reais. Upload dedicado para screenshot/existing_asset permanece pendente no roadmap; fallback declarado continua funcionando.

## Diagnóstico de falhas (offline)

O terminal mostra o erro sanitizado; `scenes[].attempts[].diagnostic` no job preserva `kind`, `httpStatus`, `requestId`, `providerCode`, `providerStatus`, `providerMessage` e `billing` quando disponíveis. Jobs antigos continuam legíveis; detalhes já descartados não podem ser recuperados.

- `invalid_request`: 400/422; `authentication`: 401/403; `quota`: 402/429 (o código e a mensagem distinguem crédito, quota e limite de chamadas); `provider`: 5xx ou tarefa falha; `timeout`, `connection`, `invalid_response`: falhas distintas de transporte/resposta.
- `billing=rejected`: HTTP 4xx explícito na criação, exceto 408, sem ID de tarefa na resposta. Não sinaliza cobrança incerta.
- `billing=unconfirmed`: pedido pode ter sido aceito (5xx, timeout, conexão, resposta inválida, falha ao consultar tarefa existente). Confira consumo/tarefas antes de repetir; não significa cobrança comprovada.
- `billing=confirmed`: tarefa informa consumo, inclusive zero. O ledger preserva esse consumo.

Somente campos diagnósticos selecionados são persistidos, com limites de tamanho e remoção de chave, credenciais, prompt, imagem e URLs. O corpo bruto e a mensagem bruta de transporte nunca são registrados. Nenhum retry foi acrescentado. A primeira tentativa histórica continua com cobrança desconhecida; confira o painel antes de autorizar outra geração.
