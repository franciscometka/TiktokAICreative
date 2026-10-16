# AI UGC

Modo "AI UGC" (Lote 5.3): foto real do produto → pessoa sintética segurando/apresentando o produto → storyboard → vídeo falado → cenas complementares → render. Hoje tudo é MOCK; o contrato real está preparado (D79–D84).

## Fluxo na interface
1. `/create` → Tipo de vídeo **AI UGC**; envie ao menos uma foto do produto.
2. Escolha preset (Econômico/Equilibrado/Premium), apresentador (automático/mulher/homem) e ambiente.
3. Revise o storyboard (quem aparece, o que segura, o que fala, o que faz) e o custo.
4. "Gerar vídeo por até R$ X" autoriza o job inteiro. A primeira etapa gera a referência e **pausa**.
5. "Esta será a pessoa apresentando seu produto": Aprovar, Gerar outra, Trocar apresentador/ambiente ou Editar conceito.
6. Após aprovar, o job continua no mesmo teto: cenas UGC → B-roll/imagens → render.

## Regras
- Nenhuma cena UGC sem referência aprovada da identidade atual.
- Mesma pessoa, figurino, ambiente e produto em todas as cenas; trocar identidade depois de existir cena UGC é recusado.
- Fala de criador; proibido "uso há meses", "testei", "funcionou comigo", "comprei", depoimentos e jargão.
- Áudio: `native_speech` (vídeo fala; sem TTS) ou `external_lipsync` (ElevenLabs + lip-sync). Nunca as duas vozes.
- Sem retry pago automático; cobrança incerta pausa; ledger append-only com categorias referência UGC, cena UGC, B-roll, voz e render.

## Variáveis
- `UGC_DIR` (default `outputs/ugc`): referências reais versionadas.
- `UGC_MOCK_AUDIO_STRATEGY` (`native_speech` | `external_lipsync`): estratégia do mock.

## Falta para o real
Ver "Falta para a primeira geração UGC real" em [TASKS.md](TASKS.md).
