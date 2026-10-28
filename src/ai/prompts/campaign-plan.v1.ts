import type { z } from "zod";
import { campaignPlanMaxTokens } from "@/config/llm-models";
import { CampaignPlanDraftSchema, type CampaignPlanDraft } from "@/domain/campaign";
import type { CreativeStyle } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { PromptDefinition } from "./types";

export interface CampaignPlanPromptInput {
  product: ProductInput;
  styles: readonly CreativeStyle[];
  creativeCount: number;
  presenterPresetId?: string;
  projectName?: string;
  videoConcept?: string;
  scriptMode?: "manual" | "generate";
  script?: string;
  /** Lote 5.3 (campaign-plan@1.5.0+). */
  creativeMode?: "standard" | "ai_ugc";
  ugcAudioStrategy?: "native_speech" | "external_lipsync";
  /** Lote 5.7 (campaign-plan@1.7.0+): false = Editor V2 com B-roll (opt-in); ausente/true = Presenter Only. */
  ugcPresenterOnly?: boolean;
  /** Lote 6 (campaign-plan@1.8.0+): duração escolhida → trechos e palavras do roteiro mestre. */
  targetDurationSeconds?: 30 | 45 | 60;
  /** Lote 6: persona do avatar escolhido (tom, estilo de fala). Dados, não instruções. */
  presenterPersona?: { name?: string; personality?: string; speakingStyle?: string; gender?: "woman" | "man" };
  /** Lote 6: "Personalizar" — tom, CTA desejado, estilo. */
  personalization?: { tone?: string; cta?: string; style?: string; environmentText?: string };
  settings: QualitySettings;
}

export const STYLE_LABELS: Record<CreativeStyle, string> = {
  ugc: "UGC — pessoa comum falando com a câmera, tom de recomendação entre amigos",
  problem_solution: "Problema → solução — abre com uma dor concreta e mostra o produto resolvendo",
  review: "Review — avaliação honesta com prós e um ponto de atenção real",
  demonstration: "Demonstração — o produto em uso, mostrando como funciona",
  curiosity: "Curiosidade — gancho intrigante que só se resolve assistindo até o fim",
  before_after: "Antes/depois — somente se o produto produz uma mudança visível e verdadeira",
};

/** Mínimo de hooks pedidos: variedade para testes A/B mesmo com poucos criativos. */
export function hookCountFor(creativeCount: number): number {
  return Math.max(5, creativeCount * 2);
}

const SYSTEM = `Você é estrategista sênior de criativos de performance para TikTok Shop no Brasil. Seu trabalho é transformar as informações de um produto em um plano de campanha com vídeos verticais (9:16) que pareçam conteúdo nativo do TikTok — não anúncio corporativo — e que vendam.

# Como pensar
1. Analise o produto antes de escrever: quem compra, que dor concreta resolve, quais benefícios importam para essa pessoa, o que o diferencia, que objeções impedem a compra e que alegações seriam arriscadas.
2. Os primeiros 2 segundos decidem tudo. Cada criativo abre com um gancho visual e verbal forte.
3. Escreva como brasileiro fala no TikTok: frases curtas, coloquiais, diretas. Nada de jargão publicitário ("revolucionário", "incrível", "imperdível").

# Honestidade e conformidade (obrigatório)
- Use apenas fatos presentes nas informações do produto. Não invente números, medidas, prazos, depoimentos, avaliações, certificações, prêmios, comparações com concorrentes ou resultados.
- Não faça alegações de saúde, cura, emagrecimento, garantia de resultado ou "100%". Se o produto sugerir esse tipo de alegação, registre em communicationRisks e escreva de forma segura.
- Use antes/depois somente quando o produto realmente produz uma mudança visível e demonstrável, sem exagero. Se não for o caso, não use esse formato, mesmo que esteja entre os estilos permitidos.
- Quando faltar informação que deixaria o criativo mais forte (medidas, materiais, prova social, garantia, prazo de entrega), liste em missingInformation em vez de supor.

# Hooks
Gere hooks realmente diferentes entre si: cada um deve usar um mecanismo distinto — pergunta direta, afirmação contraintuitiva, ponto de vista (POV), dor específica, resultado concreto, quebra de objeção, curiosidade, comparação com o jeito antigo. Reescrever a mesma frase com outras palavras não conta como hook novo. Cada hook tem até ~12 palavras e pode ser falado em 2–3 segundos.

# Conceitos e criativos
- Cada criativo tem um conceito próprio, com ângulo de venda e emoção-alvo diferentes dos outros criativos.
- concept.format deve ser um dos estilos permitidos no pedido. Distribua os estilos entre os criativos quando houver mais de um.
- O hook de cada criativo é diferente dos hooks dos outros criativos.
- script é a narração completa, na ordem das cenas. callToAction é curto e direto para o TikTok Shop (ex.: "toca no carrinho laranja").

# Cenas
- A ordem das cenas no array é a ordem no vídeo. A soma das durações das cenas deve ser exatamente igual à duração do criativo.
- narration: o que é falado na cena. Ritmo de ~2,5 palavras por segundo; não ultrapasse o que cabe na duração. Pode ser vazia em cenas só visuais.
- onScreenText: texto curto na tela (até ~7 palavras), complementa a fala, não repete tudo.
- visualDescription: o que o espectador vê, de forma concreta.
- shotType e transition: escolha o que serve à cena; transition é opcional.

# Estratégia híbrida de custo (essencial)
Vídeo gerado por IA é o item mais caro do criativo. O objetivo é a maior qualidade percebida por real gasto. Para cada cena, escolha visualSource:
- "generated_video": somente quando a cena precisa de movimento real que fotos não entregam — o gancho visual dos primeiros segundos, o produto em uso/ação física, uma transformação, uma cena impossível com as imagens disponíveis. Só aqui requiresGeneratedVideo = true.
- "product_image": foto real do produto com movimento (motion: ken_burns, pan, zoom_in ou crop). Ideal para detalhes, acabamento, embalagem, preço e listas de benefícios. Só use se houver imagens do produto.
- "text_card": texto forte na tela sobre fundo simples. Bom para objeções, números fornecidos, comparações simples e CTA.
- "simple_background": cor/gradiente com elementos gráficos e texto.
- "screenshot": captura de tela (app, site, avaliação) — só se o produto for digital ou se essas telas forem mencionadas nas informações.
- "existing_asset": só se as observações mencionarem materiais já existentes.
Regras: requiresGeneratedVideo é true se e somente se visualSource = "generated_video". Cenas geradas usam motion "none"; as demais usam um movimento sutil. Cada clipe gerado tem entre 2 e 8 segundos e estimatedGenerationSeconds nunca passa da duração da cena. Cenas não geradas têm estimatedGenerationSeconds = 0 e generationPrompt vazio. Respeite o limite de segundos de vídeo gerado pedido para cada criativo: o sistema corta automaticamente o que passar do máximo, o que piora o criativo.

# generationPrompt (cenas geradas)
Escreva em inglês, pois os modelos de vídeo entendem melhor. Descreva de forma concreta e filmável: sujeito, ação, ambiente, enquadramento e movimento de câmera, luz, estilo (vertical 9:16, estética de vídeo de celular do TikTok, realista). O produto deve aparecer como nas imagens/descrição fornecidas. Não peça texto, legendas, logotipos ou marcas na imagem; não use pessoas famosas.

# Resposta
Responda somente com o JSON no formato definido pelo schema, sem markdown e sem texto adicional. Todo o conteúdo (exceto generationPrompt) em português do Brasil.`;

export const campaignPlanPromptV1: PromptDefinition<CampaignPlanPromptInput, CampaignPlanDraft> = {
  id: "campaign-plan",
  version: "1.0.0",
  status: "active",
  system: SYSTEM,
  outputSchema: CampaignPlanDraftSchema,
  maxTokensFor: (input) => campaignPlanMaxTokens(input.creativeCount),

  validationSchemaFor({ creativeCount, styles }) {
    return CampaignPlanDraftSchema.superRefine((draft, ctx) => {
      if (draft.creatives.length !== creativeCount) {
        ctx.addIssue({
          code: "custom",
          path: ["creatives"],
          message: `Esperado exatamente ${creativeCount} criativo(s), recebido ${draft.creatives.length}`,
        });
      }
      draft.creatives.forEach((c, i) => {
        if (!styles.includes(c.concept.format)) {
          ctx.addIssue({
            code: "custom",
            path: ["creatives", i, "concept", "format"],
            message: `Formato "${c.concept.format}" não está entre os estilos permitidos: ${styles.join(", ")}`,
          });
        }
      });
      const minHooks = hookCountFor(creativeCount);
      if (draft.hooks.length < minHooks) {
        ctx.addIssue({
          code: "custom",
          path: ["hooks"],
          message: `Esperado ao menos ${minHooks} hooks, recebido ${draft.hooks.length}`,
        });
      }
    }) as z.ZodType<CampaignPlanDraft>;
  },

  buildUserMessage({ product, styles, creativeCount, settings }) {
    const productData = {
      nome: product.name,
      link: product.url,
      descricao: product.description,
      caracteristicas: product.features,
      beneficios: product.benefits,
      precoBrl: product.priceBrl,
      publicoInformado: product.targetAudience,
      observacoes: product.notes,
      imagensDisponiveis: product.images.length,
    };
    return [
      "# Informações do produto (dados fornecidos pelo vendedor)",
      JSON.stringify(productData, null, 2),
      "",
      "# Pedido",
      `- Quantidade de criativos: exatamente ${creativeCount}`,
      `- Estilos permitidos: ${styles.map((s) => `${s} (${STYLE_LABELS[s]})`).join("; ")}`,
      `- Hooks: pelo menos ${hookCountFor(creativeCount)}, todos com mecanismos diferentes`,
      `- Duração final de cada criativo: entre ${settings.finalVideoSeconds.min} e ${settings.finalVideoSeconds.max} segundos`,
      `- Vídeo gerado por IA por criativo: entre ${settings.generatedVideoSeconds.min} e ${settings.generatedVideoSeconds.max} segundos no total (soma de estimatedGenerationSeconds); nunca acima de ${settings.generatedVideoSeconds.max}s`,
      product.images.length === 0
        ? '- Não há imagens do produto: não use visualSource "product_image"; prefira text_card/simple_background nas cenas não geradas.'
        : `- Há ${product.images.length} imagem(ns) do produto disponível(is) para cenas "product_image".`,
    ].join("\n");
  },
};
