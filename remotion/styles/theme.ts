/**
 * Tokens do tema base (único tema do Lote 3). Todas as medidas em px do canvas 1080x1920.
 * Sem dependências: usado pela composição e pelos testes.
 */

export const CANVAS = { width: 1080, height: 1920 } as const;

/**
 * Áreas que a interface do TikTok/Reels cobre por cima do vídeo:
 * - topo: abas "Seguindo / Para você" e barra de status;
 * - base: nome do perfil, legenda do post, música, barra de navegação;
 * - direita: coluna de botões (curtir, comentar, compartilhar, perfil).
 * Texto importante fica dentro do retângulo restante.
 */
export const SAFE_AREA = {
  top: 200,
  bottom: 440,
  left: 72,
  right: 180,
} as const;

export const SAFE_BOX = {
  x: SAFE_AREA.left,
  y: SAFE_AREA.top,
  width: CANVAS.width - SAFE_AREA.left - SAFE_AREA.right,
  height: CANVAS.height - SAFE_AREA.top - SAFE_AREA.bottom,
} as const;

export const COLORS = {
  ink: "#0B0B0C",
  paper: "#F4F1EA",
  white: "#FFFFFF",
  muted: "rgba(255,255,255,0.72)",
  scrim: "rgba(8,8,10,0.55)",
  accent: "#FF5A36",
  placeholderBg: "#1B1D21",
  /** Faixa atrás da legenda: contraste mínimo sobre imagem clara ou escura. */
  captionBackdrop: "rgba(8,8,10,0.62)",
} as const;

export const FONT = {
  family: "Inter, system-ui, sans-serif",
  weights: { regular: 400, semibold: 600, bold: 700, heavy: 800, black: 900 },
} as const;

export const TYPE = {
  hook: { size: 92, lineHeight: 1.02, tracking: -2.5, weight: FONT.weights.black },
  sceneText: { size: 68, lineHeight: 1.05, tracking: -1.5, weight: FONT.weights.heavy },
  cardText: { size: 104, lineHeight: 1.0, tracking: -3, weight: FONT.weights.black },
  caption: { size: 58, lineHeight: 1.18, tracking: -0.5, weight: FONT.weights.heavy },
  cta: { size: 64, lineHeight: 1.05, tracking: -1, weight: FONT.weights.black },
  eyebrow: { size: 30, lineHeight: 1.2, tracking: 1.5, weight: FONT.weights.bold },
  price: { size: 76, lineHeight: 1, tracking: -1.5, weight: FONT.weights.black },
  label: { size: 30, lineHeight: 1, tracking: 2, weight: FONT.weights.black },
} as const;

export const SPACE = { xs: 8, sm: 16, md: 24, lg: 40, xl: 64 } as const;
export const RADIUS = { sm: 10, md: 18, lg: 28, pill: 999 } as const;

export const SHADOW = {
  /** Contorno de legenda legível sobre qualquer imagem. */
  captionText: "0 4px 18px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.6)",
  card: "0 20px 60px rgba(0,0,0,0.35)",
} as const;

/** Velocidades em frames (30 fps). */
export const MOTION = {
  enterFrames: 9,
  exitFrames: 7,
  crossfadeFrames: 8,
  slideDistance: 36,
  /** Escala máxima de zoom lento em imagens (8%). */
  imageZoom: 0.08,
  /** Deslocamento máximo de pan (fração da largura). */
  imagePan: 0.04,
} as const;

/** Posições verticais (topo do bloco) dentro da safe area. */
export const LAYOUT = {
  hookTop: SAFE_AREA.top + 120,
  sceneTextTop: SAFE_AREA.top + 40,
  /** Base da legenda: dentro da safe area, com folga acima da área inferior coberta pela interface. */
  captionBottom: CANVAS.height - SAFE_AREA.bottom - SPACE.sm,
  captionMaxLines: 2,
  ctaBottom: CANVAS.height - SAFE_AREA.bottom - SPACE.sm,
  progressTop: SAFE_AREA.top - 56,
  placeholderLabelTop: SAFE_AREA.top + 4,
  /** Altura reservada pelo selo do placeholder: o texto da cena começa abaixo dele. */
  placeholderLabelHeight: 84,
} as const;
