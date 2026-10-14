# Especificação — TikTok AI Creative Factory

## Objetivo
Transformar informações de um produto em múltiplos criativos verticais (1080x1920, MP4) de venda para TikTok Shop, com **controle de custo como parte central** e **aprovação humana obrigatória** antes de qualquer geração paga de mídia.

## Fluxo alvo
produto → análise (Claude) → hooks → conceitos → roteiro → plano cena a cena → estimativa de custo → **aprovação humana** → geração de cenas (provider de vídeo) → áudio → composição (Remotion) → textos/legendas/CTA → MP4 1080x1920.

## Escopo V1
- Roda localmente. Sem banco, sem integração com TikTok.
- Providers trocáveis sem reescrever o sistema (interfaces `VideoProvider`, `AudioProvider`, `LlmClient`, `Renderer`).

## Entrada (página `/create`, lote futuro)
Nome, link (opcional), descrição, características, benefícios, preço (opcional), público (opcional), observações, imagens, quantidade de criativos, estilos (UGC, Problema→solução, Review, Demonstração, Curiosidade, Antes/depois), qualidade (Econômico, Alta qualidade, Premium).

Cada card de qualidade mostra: provider/modelo planejado, segundos de vídeo IA, duração final, faixa de custo.

Após o planejamento: análise, hooks, conceitos, roteiros, cenas, prompts das cenas; depois a estimativa detalhada (Claude, áudio, vídeo, render, total) e o botão **"Gerar por aproximadamente R$X"**.

## Presets iniciais (configuráveis, não absolutos)

| Preset | Vídeo IA | Vídeo final | Meta |
|---|---|---|---|
| Econômico | 8–12s | 20–30s | R$3–6 |
| Alta qualidade | 12–20s | 25–35s | R$8–15 |
| Premium | 20–30s | 30–45s | R$25–50 |
| Custom | definido pelo usuário | — | — |

O vídeo final é mais longo que o trecho gerado por IA: o restante usa imagens do produto com zoom/pan, textos, CTA e composição Remotion.

## Regras de custo (obrigatórias)
1. Nenhuma chamada paga de mídia antes de: plano pronto → custo estimado → aprovação explícita.
2. Estimativa é sempre rotulada como estimativa; custo real é registrado separadamente.
3. Limites por vídeo e por campanha. Exceder nunca é automático: retorna `BUDGET_EXCEEDED` (custo atual, adicional, novo total, limite) e a interface oferece **Cancelar** ou **Autorizar exceder** (se a política permitir).
4. Toda regeneração soma ao custo real; tentativas descartadas nunca são escondidas.
5. Sem loops de regeneração ilimitados; sem re-tentativa paga automática após falha.
6. Preços e cotação USD→BRL centralizados e configuráveis.

## Lote 1 — planejamento real
Produto → Claude → análise (resumo, público, dores, benefícios, diferenciais, objeções, riscos de comunicação, informações ausentes) → hooks distintos → conceitos → criativos (hook, ângulo, roteiro, CTA, duração) → cenas (ordem, duração, narração, texto na tela, descrição visual, prompt de geração, enquadramento, transição, fonte visual, movimento, vídeo IA sim/não, segundos de IA) → validação Zod → adequação ao preset → estimativa.
- Modelo por preset: Sonnet 5.5 (econômico, alta), Opus 5.5 (premium).
- Estratégia híbrida: vídeo gerado só onde há movimento real; o resto com imagem do produto + movimento, texto, fundo simples, screenshot ou asset existente.
- Limite de segundos de IA validado pelo sistema; excesso é ajustado deterministicamente.
- Estimativa mostra **custo já incorrido** (Claude, real) separado do **custo futuro estimado** (vídeo, áudio, render) e o total projetado.
- Toda chamada ao Claude é registrada com custo real (inclusive tentativas inválidas).
- Persistência local de campanhas, jobs, estimativas, aprovações, ledger e chamadas.

## Fora do escopo do Lote 0
Integração real com Claude, providers de vídeo/áudio reais, ElevenLabs, banco de dados, TikTok API, página `/create`, composição Remotion.
