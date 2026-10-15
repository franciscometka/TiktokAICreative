# Execução híbrida por etapa

Partida: `ff176bb`. Modo inicial de todos os novos projetos: **MOCK**. Os seletores vivem na estratégia de `/create`; depois do planejamento, o painel **Execução por etapa** permite alterar os modos de mídia e render sem apagar dados anteriores.

| Etapa | REAL disponível quando | Execução |
|---|---|---|
| Roteiro / planejamento | `LLM_PROVIDER=anthropic` e `ANTHROPIC_API_KEY` | Cria projeto em draft; mostra pior caso e exige aprovação antes de chamar Claude. Um pedido, sem retry de validação nem transporte. |
| Narração | `AUDIO_PROVIDER=elevenlabs` e `ELEVENLABS_API_KEY` | Uma narração contínua por clique; MP3/alignment/versionamento e AudioFit existentes. |
| Cenas | `VIDEO_PROVIDER=runway` e `RUNWAYML_API_SECRET` | Uma cena por clique; valida imagens/prompts, duração comprada e MP4 salvo. |
| Presenter / avatar | `RUNWAYML_API_SECRET`, preset selecionado e narração real com alignment | Usa o áudio existente, sem TTS Runway. Uma cena por clique. |
| Render | `RENDERER=remotion`; navegador local preparado | MP4 local, sem custo de API; ação separada, sem geração automática de mídia. |

Configuração é conferida localmente, sem testar credenciais via rede. Ausência de configuração desabilita REAL e mostra o motivo. Chaves nunca vão ao browser. Reinicie o servidor depois de configurar providers.

## Combinações e dependências

As escolhas são independentes: tudo MOCK; Claude REAL com demais etapas MOCK; ElevenLabs REAL com vídeo/avatar MOCK; vídeo REAL com áudio MOCK; render local REAL com mídia MOCK; ou todas as etapas REAL. Avatar REAL exige narração REAL já salva e alinhada; ele nunca gera outra voz automaticamente. Product UGC continua reservado/desabilitado.

O botão de simulação completa só aparece quando todas as etapas de mídia/render são MOCK. Nos demais casos, use os botões por etapa. Nenhuma etapa REAL encadeia outra chamada paga — nem a próxima cena da mesma etapa. Ler, reabrir ou mudar um seletor não chama APIs.

## Estimativa, aprovação e orçamento

Cada ação apresenta provider/modelo, estado, modo, valor estimado, gasto real e valores simulados separados. Uma cotação identifica inputs, modo, unidade (cena/tarefa), preço, estado e revisão do job. **Revisar e executar REAL → Confirmar e executar REAL** aprova só aquela ação; cotação antiga ou clique concorrente é recusado. Uma nova versão usa outra cotação/confirmação e respeita o limite de tentativas.

O orçamento é rechecado sob o lock da campanha antes da execução. Os registros simulados continuam no ledger, mas não contam como dinheiro gasto no orçamento híbrido. Excedentes só podem ser autorizados se `allowOverBudget=true`, até o total exibido. Se os limites por criativo e por campanha excederem, cada escopo requer sua própria aprovação. Aprovar um não aprova o outro, e nenhum provider é chamado enquanto houver limite pendente.

A aprovação por etapa e o estimateId do job ficam persistidos. A permissão de transporte é efêmera e limitada a uma criação paga; GETs de polling não autorizam outra criação. Os comandos antigos `*:real --confirm` continuam bloqueados fora dessa autorização de etapa.

## Dados, versões e retomada

Trocar MOCK para REAL preserva tentativas, arquivos, ledger, aprovações auditadas e renders. Assets anteriores continuam ativos até sucesso da nova versão. Trocar para MOCK pode reutilizar mídia real já válida, sem gasto adicional; uma simulação nova exige o botão de nova versão. O render fica desatualizado após substituição de mídia e exige execução explícita. Uma narração vinculada a avatar REAL não é trocada isoladamente: crie uma cópia para preservar sincronização.

O planejamento define o roteiro e as cenas dos jobs existentes. Para refazê-lo depois de um plano pronto, use **Planejar de novo com ajustes** e escolha o novo modo na cópia. Jobs MOCK de ff176bb adotam os campos híbridos na primeira alteração/execução explícita, preservando plano, assets, aprovações e ledger. Projetos reais antigos ou sem modo identificado ficam consultáveis e podem ser copiados, sem migração destrutiva dos dados.

Tarefas Runway com ID salvo retomam por ação explícita, usando polling/download, sem novo POST. Intenção de envio sem ID após queda bloqueia reenvio e troca de modo para evitar duplicidade. Tentativa paga de vídeo mantém o mesmo ID de tentativa na retomada; custo deduplicado no ledger. Falhas terminais podem receber nova cotação/confirmação dentro do limite de tentativas. Timeouts de TTS continuam exibindo possível cobrança, sem retry automático.

Diagnóstico HTTP, request IDs, ledger antes de validar/armazenar, versões locais e `requestedDurationSeconds`, `providerReportedDurationSeconds`, `actualMediaDurationSeconds` permanecem no caminho real. Clipe inválido nunca entra no render; seu custo continua registrado.

## Validação e pendências reais

A suíte normal só usa transportes falsos e bloqueia rede externa. Nenhuma chamada paga foi feita nesta implementação. O caminho integrado é exercitado com providers falsos, incluindo orçamento, nova versão, restart de vídeo/avatar e ausência de cascata paga. O navegador verifica o fluxo completo MOCK.

Para um job REAL ponta a ponta: configurar os providers necessários e o navegador do Remotion; criar uma cópia híbrida com imagens autorizadas; revisar o roteiro; executar/aprovar planejamento, narração, cada cena, cada avatar e render separadamente; resolver AudioFit quando solicitado. A primeira validação paga do presenter e a validação integrada real de todas as etapas continuam pendentes de autorização do usuário. Sem worker durável ou múltiplos processos: continua um processo por DATA_DIR.

Planejamento híbrido usa `campaign-plan@1.4.0`: inclui conceito/nome do projeto/roteiro manual no brief enviado. Validação rejeita roteiro manual alterado ou fala das cenas divergente; não pede outra chamada paga automaticamente. As versões anteriores do prompt permanecem no registro.
