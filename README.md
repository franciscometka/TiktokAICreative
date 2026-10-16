> **Modo atual: fluxo simples com execução híbrida protegida.** MOCK é o padrão. A pessoa revisa o storyboard e aprova um teto único; internamente cada chamada REAL continua limitada por provider, orçamento, ledger e número de tentativas. [Guia do fluxo híbrido](docs/HYBRID-WORKFLOW.md).

# TikTok AI Creative Factory

Transforma informações de um produto em criativos verticais de venda (MP4 1080x1920) para TikTok Shop, com **estimativa de custo e aprovação humana antes de qualquer geração paga**.

> **Status: Lote 5.4.** Modo **AI UGC** (pessoa sintética segurando o produto real, aprovação da referência antes das cenas, fala natural). Transporte REAL Google (Gemini + Veo 3.1) implementado e desligado por padrão; ainda sem validação paga — ver [docs/AI-UGC.md](docs/AI-UGC.md). Criação guiada (`/create`), storyboard editável, uma aprovação por job, narração ElevenLabs, cenas e presenter Runway opcionais e render local com Remotion. O fluxo inteiro funciona em MOCK sem API externa e deixa explícito que não produz MP4. Veja [docs/TASKS.md](docs/TASKS.md).

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
1. **Produto**: nome, descrição curta e imagens. Características, benefícios, preço e público ficam em “Mais informações”. “Melhorar informações com IA” organiza apenas fatos fornecidos.
2. **Direção**: escolha Econômico (15–20s), Equilibrado (20–30s) ou Premium (30–45s), além de apresentadora, apresentador ou nenhum.
3. **Storyboard**: o sistema cria roteiro, timeline e cenas. Fala, visual e tipo de cada cena podem ser editados antes de gastar.
4. **Custo e aprovação**: um botão mostra o teto completo do job e registra uma autorização persistente.
5. **Execução automática**: narração → avatar → cenas → render. O fluxo para na primeira falha, cobrança incerta ou aumento de custo e nunca repete uma chamada paga sozinho.
6. **Resultado**: player e download quando há MP4 real; no MOCK, confirmação explícita de que nenhuma mídia final foi criada. Novas versões preservam o histórico.

Os seletores e diagnósticos por etapa continuam em **Configurações avançadas**. Assim continuam possíveis combinações como Claude e ElevenLabs reais, Runway mock e render local real.

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
| Econômico | claude-sonnet-5-5 | 6–9s | 15–20s |
| Equilibrado | claude-sonnet-5-5 | 10–16s | 20–30s |
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
| Econômico | eleven_flash_v2_5 | US$0,05 / 1.000 caracteres |
| Alta qualidade / Premium | eleven_multilingual_v2 | US$0,10 / 1.000 caracteres |

Um criativo de ~25s tem ~350–450 caracteres falados (≈ R$0,10–0,25). Preços em [src/config/pricing.ts](src/config/pricing.ts) (tabela vigente da API, 2026-10-14). O custo é calculado sobre os caracteres ENVIADOS; o header `character-cost` da ElevenLabs mede créditos/quota da assinatura (outra unidade) e só é guardado para auditoria. Validação real: 169 caracteres, `character-cost` 85, US$0,00845 (docs/TASKS.md). Vozes em [src/config/voices.ts](src/config/voices.ts) — são vozes padrão multilíngues; para sotaque brasileiro nativo, troque o voiceId por uma voz pt-BR da Voice Library.

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
