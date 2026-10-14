# TikTok AI Creative Factory

Transforma informações de um produto em criativos verticais de venda (MP4 1080x1920) para TikTok Shop, com **estimativa de custo e aprovação humana antes de qualquer geração paga**.

> **Status: Lote 4.** Interface de criação (`/create`), revisão do plano, custo, aprovação, **narração real pt-BR com ElevenLabs** (opcional, com legendas sincronizadas pela fala real) e **renderização real do MP4 com Remotion** (local). Planejamento mock (padrão) ou Claude real. Vídeo IA continua **mock**: as cenas de IA aparecem como placeholder "MOCK · VÍDEO IA". Veja [docs/TASKS.md](docs/TASKS.md).

## Requisitos
- Node.js 22+ (testado com 24)

## Começando
```bash
npm install
cp .env.example .env.local
npm run dev
```
Abra http://localhost:3000 e clique em **Criar campanha**. Funciona sem nenhuma chave (`LLM_PROVIDER=mock`, `VIDEO_PROVIDER=mock`, `AUDIO_PROVIDER=mock`).

## Fluxo
1. **Produto**: nome, descrição, características, benefícios, preço, público, observações e imagens (upload local).
2. **Estratégia**: quantidade de criativos (1/2/3/5), formatos (AUTO ou escolhidos), qualidade/custo e limites de orçamento.
3. **Planejamento**: roda em background; a página acompanha o estado. Se o servidor reiniciar no meio, a campanha aparece como *interrompida* e pode ser planejada de novo (com confirmação).
4. **Revisão**: análise, hooks, conceitos, criativos, cenas e prompts (recolhidos).
5. **Custo e aprovação**: já utilizado (real) × futuro estimado × total projetado; "Gerar por aproximadamente R$X" por criativo; diálogo de orçamento excedido.
6. **Narração**: voz escolhida no passo de estratégia (Clara, Bia, Rafael, Lucas). Com `AUDIO_PROVIDER=elevenlabs`, a narração é gerada depois da aprovação (uma chamada, custo real registrado), com timing por palavra para as legendas. Se a fala ficar muito mais longa que o planejado, o criativo pede revisão (aceitar vídeo mais longo, gerar a narração de novo ou cancelar). Com `mock`: "MODO DE TESTE", sem som.
7. **Render**: depois da aprovação, geração (mock) e render rodam em segundo plano: "Preparando assets → Renderizando (frames reais) → Concluído". O MP4 aparece num player com **Assistir**, **Baixar MP4** e **Renderizar novamente** (nova versão; nada é sobrescrito). Avisos do render (placeholder de IA, imagem ausente, sem áudio) ficam visíveis.

Histórico em `/campaigns`. Para ver a tela de processamento com o mock, use `MOCK_PLANNER_DELAY_MS=20000` em `.env.local`.

## Scripts
| Comando | O que faz |
|---|---|
| `npm run dev` | Servidor de desenvolvimento |
| `npm test` | Testes (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | lint + typecheck + testes |
| `npm run build` | Build de produção |
| `npm run plan:real` | Validação manual com o Claude real (sem `--confirm` só mostra o pior caso) |
| `npm run test:integration` | Testes pagos (só com `RUN_PAID_TESTS=1` e `ANTHROPIC_API_KEY`) |
| `npm run tts:real` | Validação manual com a ElevenLabs real (sem `--confirm` só mostra voz/modelo/custo; com `--confirm`, UMA chamada curta) |
| `npm run render:setup` | Baixa o Chrome Headless Shell do Remotion (uma vez por máquina) |
| `npm run test:render` | Teste PESADO: renderiza um MP4 real de 3s (fora do `npm test`) |

## Planejamento com Claude

```bash
# .env.local
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

| Preset | Modelo | Vídeo IA | Vídeo final |
|---|---|---|---|
| Econômico | claude-sonnet-5-5 | 8–12s | 20–30s |
| Alta qualidade | claude-sonnet-5-5 | 12–20s | 25–35s |
| Premium | claude-opus-5-5 | 20–30s | 30–45s |

Validação manual (UMA campanha, 1 criativo, preset econômico):
```bash
npm run plan:real              # mostra o custo de pior caso, não chama nada
npm run plan:real -- --confirm # faz a chamada real
```
O resultado, o custo real e as chamadas ficam em `data/manual/`.

## Narração (ElevenLabs)

```bash
# .env.local
AUDIO_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=sk_...
```
| Preset | Modelo TTS | Preço (API) |
|---|---|---|
| Econômico | eleven_flash_v2_5 | US$0,04 / 1.000 caracteres |
| Alta qualidade / Premium | eleven_multilingual_v2 | US$0,08 / 1.000 caracteres |

Um criativo de ~25s tem ~350–450 caracteres falados (≈ R$0,08–0,20). Preços em [src/config/pricing.ts](src/config/pricing.ts) (verificados em 2026-10-14); planos de assinatura usam créditos e podem sair diferentes. Vozes em [src/config/voices.ts](src/config/voices.ts) — são vozes padrão multilíngues; para sotaque brasileiro nativo, troque o voiceId por uma voz pt-BR da Voice Library.

Antes de usar em campanha, valide uma vez:
```bash
npm run tts:real              # mostra voz, modelo, caracteres e custo; não chama nada
npm run tts:real -- --confirm # UMA chamada curta real; grava em data/manual/tts/
```

## Renderização (Remotion)

```bash
npm run render:setup   # 1ª vez na máquina: baixa o Chrome Headless Shell (~100 MB) para node_modules/.remotion
# .env.local
RENDERER=remotion
```
Com `RENDERER=mock` (padrão) nada é renderizado. Com `remotion`, cada criativo aprovado vira `outputs/renders/<campanha>/<criativo>/v<N>/final.mp4` (1080x1920, 30 fps, H.264 yuv420p; trilha AAC quando a narração é real, sem áudio no mock) + `manifest.json` (props, versões, avisos). Render local: **R$ 0,00**, sem chamada de API; o 1º render do processo empacota a composição (mais lento). Mudou algo em `remotion/`? Reinicie o servidor.

**Em outro PC**: `npm install` → `cp .env.example .env.local` → `npm run render:setup` → `RENDERER=remotion` → `npm run dev`. Nada além do Node é preciso (FFmpeg vem no pacote do Remotion; a fonte Inter é local). Windows com o projeto numa pasta muito funda: se o render falhar com `ENOENT` ao abrir o Chrome, copie `node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64` para um caminho curto e defina `RENDER_BROWSER_EXECUTABLE` com o `chrome-headless-shell.exe` (ver D53).

**Licença**: o Remotion é gratuito para pessoas físicas e empresas com até 3 pessoas; empresas maiores precisam da Company License (`REMOTION_LICENSE_KEY`, ver D54).

## Dados locais
`DATA_DIR` (padrão `data/`, fora do git): `campaigns/*.json`, `jobs/*.json`, `ledger.jsonl` (custo real), `llm-calls.jsonl` (auditoria das chamadas ao Claude). Escrita atômica; use um processo por diretório.

`UPLOADS_DIR` (padrão `outputs/uploads/`, fora do git): imagens em `{productId}/img_<uuid>.<ext>`. JPG, PNG ou WebP, até 8 MB e 6 imagens por produto; o tipo é conferido pelo conteúdo do arquivo.

`AUDIO_DIR` (padrão `outputs/audio/`, fora do git): `<campanha>/<criativo>/v<N>/narration.mp3` + `timing.json` + `metadata.json`. Nunca sobrescritos.

`RENDERS_DIR` (padrão `outputs/renders/`, fora do git): `<campanha>/<criativo>/v<N>/final.mp4` + `manifest.json`. Versões nunca são sobrescritas nem apagadas automaticamente.

## Configuração
Veja [.env.example](.env.example). Preços ficam em [src/config/pricing.ts](src/config/pricing.ts) e presets em [src/config/quality-presets.ts](src/config/quality-presets.ts).
Preços de vídeo são **provisórios** até a escolha do provider; os de áudio (ElevenLabs) são oficiais.

## Documentação
- [docs/SPEC.md](docs/SPEC.md) — o que o sistema deve fazer
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — camadas, fluxo, estados, custos
- [docs/DECISIONS.md](docs/DECISIONS.md) — decisões e riscos
- [docs/TASKS.md](docs/TASKS.md) — lotes e dívida técnica
- [CLAUDE.md](CLAUDE.md) — guia para sessões do Claude
