# TikTok AI Creative Factory

Transforma informações de um produto em criativos verticais de venda (MP4 1080x1920) para TikTok Shop, com **estimativa de custo e aprovação humana antes de qualquer geração paga**.

> **Status: Lote 1.** Planejamento com o Claude real (opcional, `LLM_PROVIDER=anthropic`) e persistência local. Vídeo, áudio e renderização ainda são **mocks**. Veja [docs/TASKS.md](docs/TASKS.md).

## Requisitos
- Node.js 22+ (testado com 24)

## Começando
```bash
npm install
cp .env.example .env.local
npm run dev
```
Abra http://localhost:3000 — a home mostra os presets de qualidade com as faixas de custo calculadas pela configuração atual.

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

## Dados locais
`DATA_DIR` (padrão `data/`, fora do git): `campaigns/*.json`, `jobs/*.json`, `ledger.jsonl` (custo real), `llm-calls.jsonl` (auditoria das chamadas ao Claude). Escrita atômica; use um processo por diretório.

## Configuração
Veja [.env.example](.env.example). Preços ficam em [src/config/pricing.ts](src/config/pricing.ts) e presets em [src/config/quality-presets.ts](src/config/quality-presets.ts).
Preços de vídeo e áudio são **provisórios** até a escolha dos providers.

## Documentação
- [docs/SPEC.md](docs/SPEC.md) — o que o sistema deve fazer
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — camadas, fluxo, estados, custos
- [docs/DECISIONS.md](docs/DECISIONS.md) — decisões e riscos
- [docs/TASKS.md](docs/TASKS.md) — lotes e dívida técnica
- [CLAUDE.md](CLAUDE.md) — guia para sessões do Claude
