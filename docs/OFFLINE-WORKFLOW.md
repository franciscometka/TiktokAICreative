> **Atualização:** a interface agora oferece modos por etapa. O bloqueio absoluto abaixo descreve ff176bb; veja [HYBRID-WORKFLOW.md](HYBRID-WORKFLOW.md) para o comportamento atual. `*:real --confirm` isolado continua bloqueado.

# Fluxo offline de projetos e jobs

Esta versão está travada em modo offline. Nenhuma variável de ambiente, aprovação de orçamento ou `--confirm` libera chamadas reais. O bloqueio fica no servidor, nos transportes de produção e nos comandos `*:real`; os transportes falsos dos testes continuam disponíveis.

## Usar o sistema

1. Execute `npm run dev` e abra `/create` (ou clique em **Novo projeto**).
2. Informe nome do projeto, produto, fotos e características. As imagens ficam no armazenamento local existente.
3. Informe o conceito e escolha **Sugerir roteiro localmente** ou **Usar meu roteiro**. A sugestão usa os dados fornecidos, sem Claude. Roteiro manual: até 400 palavras/3.000 caracteres.
4. Escolha voz e avatar opcional. São presets de referência; nenhuma voz ou imagem de avatar é produzida.
5. Clique em **Planejar campanha**. Revise roteiro, cenas, identificação das cenas com apresentador, duração e estimativa de custo.
6. Clique em **Aprovar e simular**. A aprovação continua vinculada à estimativa e ao orçamento. A página acompanha roteiro, planejamento, narração, cenas, avatar e render final.
7. Abra **Jobs** (`/jobs`) e clique em **Abrir job** para continuar. A página também lista os projetos em `/campaigns`. Após uma interrupção do servidor, use **Retomar geração**; nada reinicia automaticamente.

## O que a simulação produz

- Jobs, tentativas, aprovação, etapas e ledger persistidos em disco, nos diretórios já configurados.
- Texto de narração associado ao job e versão `mock-vN`, com duração estimada. Não há MP3, alignment real ou voz ElevenLabs.
- Avatar mock separado do provider genérico; janela editorial da cena vinculada à tentativa/versão da narração. Não há lip sync real.
- Render mock versionado (`v1`, `v2`, ...), sem arquivo MP4. A interface permite simular uma nova versão explicitamente.
- Custos de referência marcados como simulados. O gasto real dos novos jobs offline é zero. Os limites continuam sendo exercitados para testar aprovação e excedentes.

Campanhas anteriores à trava ficam disponíveis para consulta, incluindo mídias e custos históricos; a execução é bloqueada. **Criar cópia offline** / **Planejar de novo com ajustes** cria outro projeto, preservando o anterior.

## Proteções preservadas

Orçamento, estimateId/aprovação, ledger append-only, locks, retomada explícita, histórico de versões e ausência de retry pago automático continuam no pipeline existente. O caminho real mantém diagnóstico HTTP, autorização de imagem, áudio/alignment ElevenLabs e a medição do MP4 com os três campos de duração. Mocks não recebem um selo falso de integridade medida: não existe MP4 para medir.

Os comandos `npm run presenter:real -- ...`, `video:real`, `tts:real` e `plan:real` continuam oferecendo dry-run sem confirmação. Com `--confirm`, falham antes de chamar rede ou alterar o job. Uma futura liberação exige uma alteração deliberada de código; ainda será necessária a confirmação original, além de orçamento e aprovação.

## Verificação

`npm run check` executa lint, tipos e testes offline. `npm run build` valida a aplicação. O teste `src/pipeline/offline-service.test.ts` cobre criação com upload/conceito/roteiro/avatar, estimativa antes da geração, aprovação, conclusão sem rede, leitura após restart, retomada sem duplicar voz/avatar/custo de mídia, render versionado e consulta de campanhas anteriores.
