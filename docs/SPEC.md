# Especificação — TikTok AI Creative Factory

## Objetivo
Transformar informações de um produto em múltiplos criativos verticais (1080x1920, MP4) de venda para TikTok Shop, com **controle de custo como parte central** e **aprovação humana obrigatória** antes de qualquer geração paga de mídia.

## Fluxo alvo
produto → análise (Claude) → hooks → conceitos → roteiro → plano cena a cena → estimativa de custo → **aprovação humana** → geração de cenas (provider de vídeo) → áudio → composição (Remotion) → textos/legendas/CTA → MP4 1080x1920.

## Escopo V1
- Roda localmente. Sem banco, sem integração com TikTok.
- Providers trocáveis sem reescrever o sistema (interfaces `VideoProvider`, `AudioProvider`, `LlmClient`, `Renderer`).

## Entrada (página `/create`, Lote 2)
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

## Regras de conteúdo (obrigatórias)
Já no prompt `campaign-plan@1.0.0`:
1. Usar só fatos presentes nas informações do produto: sem números, medidas, prazos, depoimentos, avaliações, certificações, comparações ou resultados inventados.
2. Sem alegações de saúde, cura, emagrecimento, garantia de resultado ou "100%"; riscos vão para `communicationRisks`.
3. Antes/depois só quando a mudança é visível, verdadeira e demonstrável.
4. Informação que falta vai para `missingInformation`, em vez de ser suposta.

A aplicar em `campaign-plan@1.0.1`, **antes de qualquer mídia real** (DECISIONS D42):
5. **Sem experiência inventada:** o narrador/ator não afirma uso pessoal, depoimento, teste realizado ou resultado vivido que não esteja nas informações fornecidas.
6. **Sem falsa prova visual:** alegações temporais ou características informadas pelo vendedor (ex.: "gelado por 24h", "não vaza") aparecem como informação do produto, nunca encenadas como se a cena comprovasse o fato (relógio/timelapse de "24 horas depois", teste demonstrado como prova).

## Lote 1 — planejamento real
Produto → Claude → análise (resumo, público, dores, benefícios, diferenciais, objeções, riscos de comunicação, informações ausentes) → hooks distintos → conceitos → criativos (hook, ângulo, roteiro, CTA, duração) → cenas (ordem, duração, narração, texto na tela, descrição visual, prompt de geração, enquadramento, transição, fonte visual, movimento, vídeo IA sim/não, segundos de IA) → validação Zod → adequação ao preset → estimativa.
- Modelo por preset: Sonnet 5.5 (econômico, alta), Opus 5.5 (premium).
- Estratégia híbrida: vídeo gerado só onde há movimento real; o resto com imagem do produto + movimento, texto, fundo simples, screenshot ou asset existente.
- Limite de segundos de IA validado pelo sistema; excesso é ajustado deterministicamente.
- Estimativa mostra **custo já incorrido** (Claude, real) separado do **custo futuro estimado** (vídeo, áudio, render) e o total projetado.
- Toda chamada ao Claude é registrada com custo real (inclusive tentativas inválidas).
- Persistência local de campanhas, jobs, estimativas, aprovações, ledger e chamadas.

## Lote 2 — interface de criação
- `/create` em etapas: Produto → Estratégia; depois `/campaigns/[id]`: Planejamento → Revisão → Custo e aprovação.
- Produto: nome e descrição obrigatórios; link (http/https), características e benefícios (listas), preço, público, observações e até 6 imagens (JPG/PNG/WebP, 8 MB) opcionais.
- Estratégia: 1, 2, 3 ou 5 criativos; formatos AUTO (todos permitidos, o Claude escolhe) ou escolhidos; preset Econômico/Alta qualidade/Premium (cards com números do sistema de custos); limites por criativo e por campanha (defaults do config) e opção de permitir autorizar exceder.
- O planejamento não segura a request: a campanha é criada em `planning` e a página acompanha. Sem progresso inventado: só "produto recebido" aparece como concluído.
- Interrupção (processo caiu): estado "interrompido"; planejar de novo é ação explícita e confirmada (nova chamada, possível novo custo).
- Revisão: análise, hooks (copiáveis), conceitos ligados aos criativos, roteiro, CTA, durações, cenas com tipo visual, prompts recolhidos, ajuste do preset apresentado como otimização.
- Custos: "já utilizado" (real) separado de "futuro estimado"; total projetado; "Estimativa provisória" quando o preço é placeholder.
- Aprovação por criativo, pelo estimateId exibido; com mídia mock, a interface avisa "MODO DE TESTE".
- BUDGET_EXCEEDED: diálogo com limite, custo atual, próxima geração, projetado e excedente; "Autorizar até R$X" só quando o domínio permite.
- Funciona inteiramente com LLM/vídeo/áudio mock e sem chaves.

## Fora do escopo do Lote 2
Vídeo/áudio reais, Remotion real, banco de dados, TikTok API, analytics de performance e vendas.
