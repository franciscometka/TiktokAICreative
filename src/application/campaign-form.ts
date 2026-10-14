import { z } from "zod";
import { PRESET_ORDER, type PresetQuality } from "@/config/quality-presets";
import { DEFAULT_SPEAKER_PROFILE_ID, isKnownSpeakerProfile } from "@/config/voices";
import { CREATIVE_STYLES, type CreativeStyle } from "@/domain/creative";
import type { CampaignRequest, StyleSelection } from "@/domain/pipeline";
import type { ProductImage } from "@/domain/product";
import { SAFE_PRODUCT_ID, STORED_IMAGE_NAME, UPLOAD_LIMITS } from "@/domain/upload";
import { err, ok, type Result } from "@/lib/result";

/**
 * Formulário de /create: o que vem do browser (strings, listas cruas) → CampaignRequest.
 * Mensagens em português, por campo. Nenhuma regra de custo aqui: limites e presets vêm do domínio.
 */

export const CREATIVE_COUNT_OPTIONS = [1, 2, 3, 5] as const;

export const FORM_LIMITS = {
  name: 120,
  description: 4_000,
  listItems: 15,
  listItem: 200,
  audience: 300,
  notes: 2_000,
  maxBudgetBrl: 10_000,
} as const;

/** Dados crus do formulário, como o componente cliente envia. */
export interface CampaignFormInput {
  productId: string;
  name: string;
  url: string;
  description: string;
  features: string[];
  benefits: string[];
  price: string;
  audience: string;
  notes: string;
  imageIds: string[];
  creativeCount: number;
  styleMode: StyleSelection;
  styles: string[];
  quality: string;
  /** Perfil de voz da narração (config/voices.ts). Ausente = padrão. */
  speakerProfileId?: string;
  budget: { maxCostPerCreativeBrl: string; maxCostPerCampaignBrl: string; allowOverBudget: boolean };
}

export type FieldErrors = Partial<Record<string, string>>;

export interface ParsedCampaignForm {
  productId: string;
  name: string;
  url: string | undefined;
  description: string;
  features: string[];
  benefits: string[];
  priceBrl: number | undefined;
  audience: string | undefined;
  notes: string | undefined;
  imageIds: string[];
  creativeCount: number;
  styleSelection: StyleSelection;
  styles: CreativeStyle[];
  quality: PresetQuality;
  speakerProfileId: string;
  budget: { maxCostPerCreativeBrl: number; maxCostPerCampaignBrl: number; allowOverBudget: boolean };
}

/** "R$ 1.299,90" | "79,90" | "79.90" → número. Vazio → undefined. Inválido → NaN. */
export function parseBrlAmount(raw: string): number | undefined {
  const text = raw.replace(/R\$/gi, "").replace(/\s/g, "");
  if (text === "") return undefined;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

const trimmed = (max: number, label: string) =>
  z.string().trim().max(max, `${label}: no máximo ${max} caracteres.`);

const optionalText = (max: number, label: string) =>
  trimmed(max, label).transform((v) => (v === "" ? undefined : v));

const list = (label: string) =>
  z
    .array(z.string())
    .transform((items) => items.map((i) => i.trim()).filter((i) => i.length > 0))
    .pipe(
      z
        .array(z.string().max(FORM_LIMITS.listItem, `Cada item de ${label} tem no máximo ${FORM_LIMITS.listItem} caracteres.`))
        .max(FORM_LIMITS.listItems, `No máximo ${FORM_LIMITS.listItems} itens em ${label}.`),
    );

const money = (label: string, required: boolean) =>
  z.string().transform((raw, ctx) => {
    const value = parseBrlAmount(raw);
    if (value === undefined) {
      if (required) ctx.addIssue({ code: "custom", message: `Informe ${label}.` });
      return undefined;
    }
    if (Number.isNaN(value) || value <= 0) {
      ctx.addIssue({ code: "custom", message: `${label[0]?.toUpperCase()}${label.slice(1)} precisa ser um valor positivo (ex.: 79,90).` });
      return undefined;
    }
    if (value > FORM_LIMITS.maxBudgetBrl && required) {
      ctx.addIssue({ code: "custom", message: `Use um limite de até R$ ${FORM_LIMITS.maxBudgetBrl.toLocaleString("pt-BR")}.` });
      return undefined;
    }
    return value;
  });

const FormSchema = z
  .object({
    productId: z.string().regex(SAFE_PRODUCT_ID, "Identificador do produto inválido."),
    name: trimmed(FORM_LIMITS.name, "Nome").min(1, "Informe o nome do produto."),
    url: z
      .string()
      .trim()
      .transform((v) => (v === "" ? undefined : v))
      .pipe(z.url({ protocol: /^https?$/, message: "Use um link completo, começando com https://." }).optional()),
    description: trimmed(FORM_LIMITS.description, "Descrição").min(1, "Descreva o produto."),
    features: list("características"),
    benefits: list("benefícios"),
    price: money("o preço", false),
    audience: optionalText(FORM_LIMITS.audience, "Público"),
    notes: optionalText(FORM_LIMITS.notes, "Observações"),
    imageIds: z
      .array(z.string().regex(STORED_IMAGE_NAME, "Imagem inválida."))
      .max(UPLOAD_LIMITS.maxImagesPerProduct, `No máximo ${UPLOAD_LIMITS.maxImagesPerProduct} imagens.`),
    creativeCount: z.number().refine((n) => (CREATIVE_COUNT_OPTIONS as readonly number[]).includes(n), {
      message: `Escolha ${CREATIVE_COUNT_OPTIONS.join(", ")} criativos.`,
    }),
    styleMode: z.enum(["auto", "manual"], { message: "Escolha AUTO ou formatos específicos." }),
    styles: z.array(z.string()),
    quality: z.string().refine((q): q is PresetQuality => (PRESET_ORDER as readonly string[]).includes(q), {
      message: "Escolha um nível de qualidade.",
    }),
    speakerProfileId: z
      .string()
      .optional()
      .refine((id) => id === undefined || id === "" || isKnownSpeakerProfile(id), { message: "Escolha uma voz da lista." }),
    budget: z.object({
      maxCostPerCreativeBrl: money("o limite por criativo", true),
      maxCostPerCampaignBrl: money("o limite por campanha", true),
      allowOverBudget: z.boolean(),
    }),
  })
  .superRefine((form, ctx) => {
    if (form.styleMode === "manual") {
      const valid = form.styles.filter((s) => (CREATIVE_STYLES as readonly string[]).includes(s));
      if (valid.length === 0 || valid.length !== form.styles.length) {
        ctx.addIssue({ code: "custom", path: ["styles"], message: "Escolha ao menos um formato ou use AUTO." });
      }
    }
    const { maxCostPerCreativeBrl: creative, maxCostPerCampaignBrl: campaign } = form.budget;
    if (creative !== undefined && campaign !== undefined && creative > campaign) {
      ctx.addIssue({
        code: "custom",
        path: ["budget", "maxCostPerCreativeBrl"],
        message: "O limite por criativo não pode ser maior que o limite da campanha.",
      });
    }
  });

export function parseCampaignForm(input: unknown): Result<ParsedCampaignForm, FieldErrors> {
  const parsed = FormSchema.safeParse(input);
  if (!parsed.success) {
    const errors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join(".") : "form";
      errors[key] ??= issue.message;
    }
    return err(errors);
  }
  const f = parsed.data;
  const styles: CreativeStyle[] =
    f.styleMode === "auto" ? [...CREATIVE_STYLES] : [...new Set(f.styles as CreativeStyle[])];
  return ok({
    productId: f.productId,
    name: f.name,
    url: f.url,
    description: f.description,
    features: f.features,
    benefits: f.benefits,
    priceBrl: f.price,
    audience: f.audience,
    notes: f.notes,
    imageIds: [...new Set(f.imageIds)],
    creativeCount: f.creativeCount,
    styleSelection: f.styleMode,
    styles,
    quality: f.quality as PresetQuality,
    speakerProfileId: f.speakerProfileId || DEFAULT_SPEAKER_PROFILE_ID,
    budget: {
      // Os dois foram validados como obrigatórios acima.
      maxCostPerCreativeBrl: f.budget.maxCostPerCreativeBrl ?? 0,
      maxCostPerCampaignBrl: f.budget.maxCostPerCampaignBrl ?? 0,
      allowOverBudget: f.budget.allowOverBudget,
    },
  });
}

/** Monta o pedido do domínio. `images` vem do UploadStore (nunca de caminhos enviados pelo browser). */
export function toCampaignRequest(form: ParsedCampaignForm, images: readonly ProductImage[]): CampaignRequest {
  return {
    product: {
      id: form.productId,
      name: form.name,
      url: form.url,
      description: form.description,
      features: form.features,
      benefits: form.benefits,
      priceBrl: form.priceBrl,
      targetAudience: form.audience,
      images: [...images],
      notes: form.notes,
    },
    styles: form.styles,
    styleSelection: form.styleSelection,
    creativeCount: form.creativeCount,
    quality: form.quality,
    budget: form.budget,
    speakerProfileId: form.speakerProfileId,
  };
}

/** Valores iniciais a partir de uma campanha existente ("planejar de novo com ajustes"). */
export function formInputFromRequest(request: CampaignRequest): CampaignFormInput {
  const p = request.product;
  const toInput = (n: number) => n.toFixed(2).replace(".", ",");
  return {
    productId: p.id,
    name: p.name,
    url: p.url ?? "",
    description: p.description,
    features: p.features,
    benefits: p.benefits,
    price: p.priceBrl === undefined ? "" : toInput(p.priceBrl),
    audience: p.targetAudience ?? "",
    notes: p.notes ?? "",
    imageIds: p.images.map((i) => i.id).filter((id) => STORED_IMAGE_NAME.test(id)),
    creativeCount: request.creativeCount,
    styleMode: request.styleSelection ?? "manual",
    styles: request.styleSelection === "auto" ? [] : request.styles,
    quality: request.quality === "custom" ? "economy" : request.quality,
    speakerProfileId: request.speakerProfileId ?? DEFAULT_SPEAKER_PROFILE_ID,
    budget: {
      maxCostPerCreativeBrl: toInput(request.budget.maxCostPerCreativeBrl),
      maxCostPerCampaignBrl: toInput(request.budget.maxCostPerCampaignBrl),
      allowOverBudget: request.budget.allowOverBudget,
    },
  };
}
