import type { ProjectStatus } from "./project-v2-view";

/**
 * L8.8 — Command Palette: itens e navegação por teclado (puros). Só navegação e criação; NENHUMA
 * ação destrutiva, de aprovação de gasto ou retry pago passa por aqui. Dados: ações fixas +
 * projetos/avatares resumidos que o shell já recebe (sem busca global no backend).
 */

export interface PaletteItem {
  id: string;
  group: "Ações" | "Projetos recentes" | "Projetos" | "Avatares";
  label: string;
  hint?: string;
  href: string;
  icon: "spark" | "avatar" | "projects" | "credits" | "settings" | "project" | "home";
  keywords?: string;
}

export interface PaletteData {
  projects: readonly { id: string; name: string; statusLabel: string; status: ProjectStatus }[];
  avatars: readonly { id: string; name: string; active: boolean }[];
}

export const PALETTE_ACTIONS: readonly PaletteItem[] = [
  { id: "action:create", group: "Ações", label: "Criar novo vídeo", href: "/create", icon: "spark", keywords: "novo video criar gerar" },
  { id: "action:avatar", group: "Ações", label: "Criar avatar", href: "/avatars/new", icon: "avatar", keywords: "novo apresentador" },
  { id: "page:projects", group: "Ações", label: "Abrir Projetos", href: "/projects", icon: "projects", keywords: "biblioteca videos" },
  { id: "page:avatars", group: "Ações", label: "Abrir Avatares", href: "/avatars", icon: "avatar", keywords: "apresentadores" },
  { id: "page:credits", group: "Ações", label: "Abrir Créditos", href: "/credits", icon: "credits", keywords: "saldo uso consumo" },
  { id: "page:settings", group: "Ações", label: "Abrir Configurações", href: "/settings", icon: "settings", keywords: "vozes avançado diagnóstico" },
  { id: "page:home", group: "Ações", label: "Ir para o Início", href: "/", icon: "home", keywords: "inicio home" },
];

const RECENT_LIMIT = 5;
const RESULT_LIMIT = 8;
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Busca vazia: ações + recentes. Com texto: ações, projetos e avatares que combinam (sem sugestão falsa). */
export function paletteItems(query: string, data: PaletteData): PaletteItem[] {
  const term = strip(query.trim());
  const projectItem = (p: PaletteData["projects"][number], group: PaletteItem["group"]): PaletteItem => ({ id: `project:${p.id}`, group, label: p.name, hint: p.statusLabel, href: `/campaigns/${encodeURIComponent(p.id)}`, icon: "project" });
  if (!term) return [...PALETTE_ACTIONS.slice(0, 6), ...data.projects.slice(0, RECENT_LIMIT).map((p) => projectItem(p, "Projetos recentes"))];
  const match = (...values: (string | undefined)[]) => values.some((v) => v && strip(v).includes(term));
  return [
    ...PALETTE_ACTIONS.filter((a) => match(a.label, a.keywords)),
    ...data.projects.filter((p) => match(p.name, p.statusLabel)).slice(0, RESULT_LIMIT).map((p) => projectItem(p, "Projetos")),
    ...data.avatars.filter((a) => match(a.name)).slice(0, RESULT_LIMIT).map((a): PaletteItem => ({ id: `avatar:${a.id}`, group: "Avatares", label: a.name, hint: a.active ? "Avatar" : "Avatar inativo", href: `/avatars/${encodeURIComponent(a.id)}`, icon: "avatar" })),
  ];
}

/** Setas percorrem SÓ itens selecionáveis (cabeçalhos de grupo não entram), com volta circular. */
export function moveActive(active: number, count: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (active < 0) return key === "ArrowDown" ? 0 : count - 1;
  return (active + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

/** Ctrl+K (Windows/Linux) ou ⌘K (macOS). Sem outros atalhos neste lote. */
export function isPaletteShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey?: boolean; shiftKey?: boolean }, mac: boolean): boolean {
  return e.key.toLowerCase() === "k" && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** Agrupa mantendo a ordem; o índice global (para aria-activedescendant) segue a lista plana. */
export function groupItems(items: readonly PaletteItem[]): { group: PaletteItem["group"]; items: { item: PaletteItem; index: number }[] }[] {
  const groups: { group: PaletteItem["group"]; items: { item: PaletteItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last && last.group === item.group) last.items.push({ item, index });
    else groups.push({ group: item.group, items: [{ item, index }] });
  });
  return groups;
}
