import type { CostCategory } from "@/domain/cost";
import type { CreativeStyle, Motion, ShotType, Transition, VisualSource } from "@/domain/creative";
import type { CampaignStatus, JobStatus } from "@/domain/pipeline";

/** Textos de interface para os enums do domínio. Sem regra de negócio. */

export const STYLE_NAMES: Record<CreativeStyle, string> = {
  ugc: "UGC",
  problem_solution: "Problema → solução",
  review: "Review",
  demonstration: "Demonstração",
  curiosity: "Curiosidade",
  before_after: "Antes/depois",
};

export const STYLE_HINTS: Record<CreativeStyle, string> = {
  ugc: "Pessoa comum recomendando, tom de conversa.",
  problem_solution: "Abre com uma dor concreta e mostra a solução.",
  review: "Avaliação honesta, com prós e um ponto de atenção.",
  demonstration: "O produto em uso, mostrando como funciona.",
  curiosity: "Gancho intrigante que se resolve no fim.",
  before_after: "Só quando a mudança é visível e verdadeira.",
};

export const VISUAL_SOURCE_NAMES: Record<VisualSource, string> = {
  generated_video: "Vídeo IA",
  product_hero: "Produto em destaque", product_demo: "Produto em uso", lifestyle: "Contexto de uso", presenter: "Apresentador", product_ugc: "Pessoa com produto",
  product_image: "Imagem do produto",
  text_card: "Texto na tela",
  screenshot: "Captura de tela",
  simple_background: "Fundo simples",
  existing_asset: "Asset existente",
};

export const MOTION_NAMES: Record<Motion, string> = {
  none: "sem movimento",
  ken_burns: "Ken Burns",
  pan: "pan",
  zoom_in: "zoom",
  crop: "recorte",
};

export const SHOT_TYPE_NAMES: Record<ShotType, string> = {
  close_up: "Close",
  medium: "Plano médio",
  wide: "Plano aberto",
  product_detail: "Detalhe do produto",
  pov: "POV",
  hands: "Mãos",
  talking_head: "Pessoa falando",
  text_card: "Card de texto",
};

export const TRANSITION_NAMES: Record<Transition, string> = {
  cut: "corte",
  fade: "fade",
  slide: "slide",
  zoom: "zoom",
};

export const COST_CATEGORY_NAMES: Record<CostCategory, string> = {
  llm: "Planejamento Claude",
  video: "Vídeo",
  audio: "Áudio",
  rendering: "Renderização",
};

export const CAMPAIGN_STATUS_NAMES: Record<CampaignStatus | "interrupted", string> = {
  draft: "Rascunho",
  planning: "Planejando",
  planned: "Planejada",
  failed: "Falhou",
  interrupted: "Interrompida",
};

export const JOB_STATUS_NAMES: Record<JobStatus, string> = {
  planned: "Planejado",
  cost_estimated: "Aguardando aprovação",
  awaiting_approval: "Aguardando aprovação",
  generating: "Gerando",
  budget_exceeded: "Orçamento excedido",
  audio_review: "Revisar narração",
  rendering: "Renderizando",
  completed: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
};
