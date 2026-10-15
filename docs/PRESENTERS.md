> **Estado atual:** chamadas reais/pagas temporariamente bloqueadas, inclusive com `--confirm`. A interface executa somente mocks. Consulte [fluxo offline](OFFLINE-WORKFLOW.md). As instruções reais abaixo documentam a integração preservada para futura liberação.

# Presenter real — Lote 5

Implementado em 2026-10-15, sem chamadas reais/pagas. A validação de qualidade visual, disponibilidade do preset na conta e sincronização perceptiva em português depende da primeira execução autorizada.

## Contrato oficial escolhido

- `POST https://api.dev.runwayml.com/v1/avatar_videos`, API version `2024-11-06`, modelo `gwm1_avatars`.
- Corpo: `{ model, avatar: { type: "runway-preset", presetId }, speech: { type: "audio", audio: "data:audio/wav;base64,..." } }`.
- Sem `speech.text`, `voice` ou chamada de TTS na Runway. Não usa Realtime Sessions/Characters conversacionais: o anúncio precisa de arquivo MP4 assíncrono, não de conversa WebRTC.
- Polling em `GET /v1/tasks/{id}`. O provider de presenter é separado de `VideoProvider`; apenas HTTP/diagnóstico sanitizado é compartilhado em `providers/runway-http.ts`.
- Presets oficiais configurados no domínio: `influencer`, `human-resource`, `fashion-designer`, `cooking-teacher`, `tennis-coach`, `music-superstar`, `game-character`, `game-character-man`, `cat-character`. Nenhum personagem customizado é criado automaticamente.

Fontes consultadas: [SDK oficial — Avatar Videos](https://github.com/runwayml/sdk-node/blob/main/src/resources/avatar-videos.ts), [playground oficial e tarifa do endpoint](https://dev.runwayml.com/endpoints/avatar_videos), [preços e valor do crédito](https://docs.dev.runwayml.com/guides/pricing/), [áudio aceito](https://docs.dev.runwayml.com/assets/inputs/).

## Reutilização da ElevenLabs e timeline

1. Narração real contínua e `timing.json` já existentes, ou a geração normal de narração ElevenLabs da campanha, feita uma única vez após aprovação.
2. Alignment real determina início da fala de cada cena. Toda cena precisa de fala/alinhamento em campanhas com presenter; não usamos timing estimado para lip sync.
3. Janela do trecho: início da fala da cena até início da fala seguinte; primeira cena começa em zero para manter silêncio inicial, última vai até o fim do MP3. Assim o trecho inclui as pausas e nenhuma fala da cena seguinte.
4. FFmpeg local, já distribuído com Remotion, decodifica e recorta em PCM WAV mono 16 kHz/16 bits. Antes do POST, o provider valida chunks, completude e duração do WAV (diferença máxima 20 ms). Limite local conservador: 30 s por trecho e 5 MB codificados.
5. MP4 recebido é salvo em nova `vN`, inspecionado no disco e comparado com a duração do trecho. Preservados `requestedDurationSeconds`, `providerReportedDurationSeconds`, `actualMediaDurationSeconds`, tolerância do c730d57 e bloqueio do render em falha.
6. No Remotion, as fronteiras das cenas seguem o alignment real quando há presenter; transições são cortes para não deslocar os lábios. O clipe fica mudo e `contain`; a narração original toca uma única vez na trilha contínua.

O manifest pode ficar mais curto ou mais longo que a duração editorial sugerida, pois segue a fala real. AudioFit continua exigindo revisão para fala muito longa, antes de gerar o avatar. Não se pode regerar a narração isoladamente depois de ter presenter ativo, pois invalidaria o lip sync: crie outra campanha para mudar a voz/texto. A regeneração do vídeo do avatar usa o mesmo áudio.

## Aprovação, custo, retomada e versões

- Tarifa do endpoint Avatar Videos: 1 crédito por 3 segundos de vídeo; sem custo de síntese de fala quando se envia áudio. A tarifa de Realtime Sessions (com custo inicial) é outra rota e não foi aplicada aqui.
- Estimativa conservadora por clipe: `ceil(segundos / 3)` créditos, US$0,01 por crédito. Exemplo: 5 s = 2 créditos = US$0,02, aproximadamente R$0,11 com câmbio de 5,50. A duração editorial da cena é a premissa antes de o áudio existir; a janela medida é recalculada antes do POST e passa pela checagem de orçamento.
- Quando a task informa `cost.credits`, prevalece esse consumo; em sucesso sem `cost`, registra-se o custo pela tarifa e duração solicitada (não é confirmação do extrato da conta). Falha terminal sem consumo informado mantém diagnóstico de cobrança desconhecida, sem inventar custo zero. Conferir o consumo da conta na primeira validação.
- `presenterTasks` registra intenção `submitting` antes do POST, depois `pending` com providerJobId/requestId. Guarda avatar, intervalo, tentativa/versão da narração, estimativa e custo registrado. Bytes de áudio, chave e URLs temporárias não são persistidos no job.
- Timeout de polling mantém a tarefa pendente e o job interrompido. Ação explícita de retomar faz polling/download da mesma task. Reiniciar não gera outro POST.
- Queda após envio sem ID confirmado deixa intenção `submitting`: nunca é reenviada automaticamente. Conferir a Runway antes de decidir criar outro teste.
- Ledger é gravado antes de validar/salvar o clipe, com ID derivado da tentativa e consulta de deduplicação na retomada (mesmo processo/lock do projeto). Versões antigas e custos de tentativas falhas/descartadas são preservados.
- Nova versão de presenter concluído exige confirmação no painel, checagem de orçamento e limite de tentativas. Falha da regeneração mantém o vídeo anterior ativo. Após falha inicial terminal, uma nova estimativa/aprovação permite nova tentativa explícita.

## Interface e primeira validação

Na criação, escolha a voz ElevenLabs e o avatar em **Avatar apresentador**. O planner `campaign-plan@1.3.0` recebe a escolha; o pipeline garante uma primeira cena gerada com fala como presenter. O painel da campanha mostra avatar, status, estimativa, custo registrado, duração medida, preview da versão válida e confirmação para gerar outra versão. O preview só serve arquivos registrados no job, por IDs e com suporte a Range.

Configuração para campanha completa: `AUDIO_PROVIDER=elevenlabs`, chave ElevenLabs, `RUNWAYML_API_SECRET` e `VIDEO_PROVIDER=runway` caso as outras cenas também devam ser reais. `RENDERER=remotion` produz o MP4 final. Revise plano/estimativa antes de aprovar: outras cenas e a primeira narração têm seus próprios custos.

Validação de UMA chamada de avatar, reutilizando um job que já tem narração real/alignment:

```powershell
npm run presenter:real -- --job ID_DO_JOB_COM_NARRACAO_REAL --avatar influencer
npm run presenter:real -- --job ID_DO_JOB_COM_NARRACAO_REAL --avatar influencer --confirm
```

`--scene ID_DA_CENA` escolhe o trecho; sem ele, usa a primeira cena com fala. Sem `--confirm`: sem chave necessária, sem rede/gravações; imprime caminho do áudio, versão/intervalo, avatar, modelo, duração e custo. Com `--confirm`: copia localmente a narração para campanha isolada, aprova a estimativa e gera UMA cena de avatar. Nenhuma chamada a Claude, ElevenLabs ou image-to-video; renderer mock. A estimativa não inclui nova síntese para o áudio copiado e o metadata aponta o job de origem. Campanha/job/áudio/ledger de origem não são alterados.

Se a tarefa da validação ficou pendente:

```powershell
npm run presenter:real -- --job ID_DO_JOB_DE_VALIDACAO_IMPRESSO --resume --confirm
```

Somente polling/download, sem novas gerações. `--resume` sem `--confirm` também é dry-run, sem chamadas nem gravações. A CLI recusa retomada que precisaria criar outra cena. Este checkout não continha job com narração real + alignment salvo durante a implementação; substitua o ID por um job elegível. Os testes exercitam os comandos com rede proibida/transporte falso e áudio local decodificável.

## Product UGC depois

`providers/presenter/product-ugc.ts` só prepara/valida o contrato de `POST /v1/recipes/product_ugc`, versão fixa `2026-06`: imagem da pessoa com `imageConsent=true`, imagem do produto, `productInfo`, `userConcept` (direção/script), 4–15 s, saída 720:1280 e `audio=false`. Não existe transporte nem seleção automática dessa Recipe.

[Contrato oficial](https://github.com/runwayml/sdk-node/blob/main/src/resources/recipes.ts), [guia oficial](https://docs.dev.runwayml.com/recipes/product-ugc/). `audio=false` é suportado, mas esse contrato não aceita o arquivo ElevenLabs como entrada de lip sync; a estratégia futura será pessoa mostrando o produto em silêncio com narração externa. Fala labialmente sincronizada nesse vídeo exigirá uma etapa/rota compatível, verificada antes de habilitar. Autorizar a imagem é obrigatório; nenhuma rota aceita pessoa real sem consentimento declarado.

Regras mantidas no prompt: sem experiência pessoal/teste/depoimento inventados e sem encenar prova visual de claims.

## Validação da implementação

npm run check aprovado: 517 testes offline em 46 arquivos, lint e TypeScript. npm run build aprovado. Cobertura inclui recorte PCM local, payload de áudio, aprovação/orçamento, HTTP sanitizado, polling/timeout, restart sem POST/custo duplicado (inclusive custo já persistido), clipes inválidos, três durações, versões/regeneração, preview por IDs, seleção de avatar e CLI em dry-run/confirm com transporte falso. Nenhuma chamada real/paga, nenhuma nova voz, nenhum push.
