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

## Integridade de duração (após a 1ª geração real)

Primeiro MP4 real (campanha `campaign_f738c092-e087-4158-ac3e-79dbae1a6c4e`, cena `scene_a76b29a5…`, `v1/clip.mp4`), medido localmente com o ffprobe do Remotion, sem chamar a Runway:
- duração do container e da trilha: **5,042s** (121 quadros, 24 fps, H.264 High, 720×1280, sem áudio, 1,26 MB); todos os quadros decodificam;
- caixas: `ftyp`, `uuid` (~354 KB, metadados do provider), `free`, `mdat`, `moov` no FIM (sem faststart);
- quadros de 0s, 1s, 2,5s e 4,9s diferem (aproximação lenta contínua): o vídeo se move até o fim; o produto já sai cortado nas laterais (crop do centro para 720:1280);
- o render daquela campanha foi `mock` (não existe MP4 final) e a cena no plano tinha 3s.
Conclusão: o ARQUIVO tem ~5s; a impressão de ~1s veio da reprodução (movimento muito sutil depois do 1º segundo e/ou player que não lê o `moov` no fim), não de truncamento.

Agora cada clipe salvo é medido: `requestedDurationSeconds`, `providerReportedDurationSeconds` (Runway: indisponível) e `actualMediaDurationSeconds` ficam em `attempt.media` e em `integrity.json`. Fora da tolerância (max 0,25s; 5%): clipe rejeitado, custo mantido, sem retry, fora do render, erro claro. `video:real` imprime `solicitado / provider / arquivo real`.


## Porte de qualidade visual sobre c730d57

O porte usa os arquivos remanescentes da sessão anterior como referência sem importar a arquitetura de avatares/receitas. Os objetos Git ab6a67c e 3edc5be não estavam disponíveis localmente; não houve cherry-pick. Cópia dos arquivos não rastreados originais: C:/Users/franc/Documents/Codex/2026-10-14/referenced-chatgpt-conversation-this-is-an-4/work/previous-session.

- Gen-4 Turbo mantém o contrato e o custo atuais. Escolhe a proporção aceita que minimiza o corte da primeira foto; 9:16 só é preferida se a perda for até 8%. Foto quadrada usa 960:960. Isso reduz crop, mas proporções intermediárias ainda podem perder bordas; não há outpainting.
- Remotion usa contain em todos os clipes reais: o quadro do vídeo fica inteiro, com espaço nas áreas restantes. A duração da cena continua seguindo o plano; contain preserva o enquadramento, não aumenta o tempo da cena.
- Fonte única de tipos em creative.ts: product_hero, product_demo, lifestyle, presenter, product_ugc e generated_video legado. Hero usa deslocamento lateral leve; demo usa câmera fixa e ação; lifestyle usa handheld suave. Direction opcional controla câmera/ação/ambiente/ritmo. Planos antigos recebem defaults, substituindo inclusive prompts antigos de aproximação.
- campaign-plan@1.2.0 adapta 1.0.1 e preserva regras de honestidade. Ainda sem validação com Claude real. Presenter/product_ugc são reservados e rejeitados pelo provider antes do POST; não se promete lip sync/avatar nesta arquitetura.
- Apenas a primeira foto vai ao image-to-video. Não foi introduzido envio múltiplo, Product Ad nem seleção automática de receitas em economy/high (ou premium).
- Preservados requestedDurationSeconds, providerReportedDurationSeconds e actualMediaDurationSeconds, inspeção do arquivo salvo, tolerância, custo em falhas, ausência de retry e bloqueio de clipes inválidos no render.

Próximo teste local, sem custo: `npm run video:real -- --image "CAMINHO_ABSOLUTO_DA_FOTO_QUADRADA"` (sem --confirm). Conferir 960:960, prompt lateral e 25 créditos para 5s. O comando apenas imprime a prévia; não cria campanha nem faz chamadas. Repetir com foto vertical se necessário. Avaliação visual real depende de teste pago posterior expressamente autorizado.

Validação do porte: npm run check aprovado (42 arquivos, 492 testes offline); npm run build aprovado após recriar cache gerado do Turbopack. Dry-run com foto local confirmado: 960:960, câmera lateral, 5s/25 créditos, nenhuma chamada. Teste da CLI usa limite de 35s, compatível com o subprocesso de até 30s; houve timeout de 5s quando check e build rodaram juntos.
