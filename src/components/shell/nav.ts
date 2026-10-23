import { Command, House, LayoutGrid, Settings, UserRound, Zap, type LucideIcon } from "lucide-react";

/**
 * L8.1 — navegação do Cinematic AI Studio (sidebar desktop, bottom nav mobile, título da topbar).
 * `icon: "spark"` = assinatura ✦ (Criar vídeo). Itens "em breve" não são links (sem botão morto):
 * aparecem desabilitados até o lote que os implementa (Créditos L8.2, Command Palette L8.8).
 */

export interface NavItem {
  href: string;
  label: string;
  /** Rótulo curto para a bottom nav. */
  short: string;
  icon: LucideIcon | "spark";
}

export interface SoonItem {
  id: "palette";
  label: string;
  icon: LucideIcon;
  hint: string;
}

export const NAV_MAIN: readonly NavItem[] = [
  { href: "/", label: "Início", short: "Início", icon: House },
  { href: "/create", label: "Criar vídeo", short: "Criar", icon: "spark" },
  { href: "/projects", label: "Projetos", short: "Projetos", icon: LayoutGrid },
  { href: "/avatars", label: "Avatares", short: "Avatares", icon: UserRound },
];

/** L8.2: Créditos virou rota real. */
export const NAV_CREDITS: NavItem = { href: "/credits", label: "Créditos", short: "Créditos", icon: Zap };

export const NAV_SOON: readonly SoonItem[] = [
  { id: "palette", label: "Command Palette", icon: Command, hint: "Busca e atalhos rápidos chegam em breve." },
];

export const NAV_FOOTER: readonly NavItem[] = [{ href: "/settings", label: "Configurações", short: "Ajustes", icon: Settings }];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/projects") return pathname.startsWith("/projects") || pathname.startsWith("/campaigns") || pathname.startsWith("/jobs");
  return pathname === href || pathname.startsWith(`${href}/`);
}

const TITLES: readonly [string, string][] = [
  ["/create", "Criar vídeo"], ["/projects", "Projetos"], ["/campaigns", "Projeto"], ["/jobs", "Jobs"],
  ["/avatars/new", "Novo avatar"], ["/avatars", "Avatares"], ["/settings", "Configurações"], ["/login", "Entrar"], ["/credits", "Créditos"],
];

/**
 * Telas já 100% Cinematic AI Studio (dark nativo, sem a superfície clara temporária).
 * Cada lote de redesign adiciona a sua rota aqui.
 */
export const DARK_ROUTES: readonly string[] = ["/", "/create", "/credits", "/campaigns", "/projects"];

export function isDarkRoute(pathname: string): boolean {
  // "/" (Home, L8.3) vale só para a própria Home, nunca como prefixo das outras rotas.
  return DARK_ROUTES.some((route) => pathname === route || (route !== "/" && pathname.startsWith(`${route}/`)));
}

/** Título da topbar a partir da rota (contexto curto; o nome longo do projeto fica na página). */
export function pageTitle(pathname: string): string {
  if (pathname === "/") return "Início";
  return TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? "Creative Factory";
}
