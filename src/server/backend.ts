import { getAvatarDetail, getAvatarView, listAvatarViews, listVoiceProfileViews, type AvatarDetailView, type AvatarView, type VoiceProfileView } from "@/application/avatar-actions";
import { getCampaignView, type ActionResult } from "@/application/campaign-actions";
import type { CampaignView } from "@/application/campaign-view";
import type { V2EstimateView } from "@/application/create-v2";
import { buildProjectV2View, listProjectCards, matchesFilter, type ProjectCard, type ProjectFilter, type ProjectV2View } from "@/application/project-v2-view";
import type { PublicAppConfig } from "@/application/public-config";
import type { WorkerStatusView } from "@/application/worker-status";
import { creditsSummary, loadCreditsView, type CreditsResult, type CreditsSummary } from "@/application/credits";
import { buildShellSummary, type ShellSummary } from "@/application/shell-summary";
import { loadFrontendEnv } from "@/cloud/config";
import type { PresetSummary } from "@/costs/preset-summary";
import { getPresetSummaries, getPublicConfig, getRuntime, getV2Estimates } from "./runtime";
import { requireAccessToken, runtimeMode, accessToken } from "./session";

/**
 * Lote 7 (D108): de onde as telas V2 leem e para onde as ações vão.
 * - "local" (padrão, `npm run dev`): runtime no próprio processo Next, como sempre.
 * - "cloud" (Vercel): tudo pela Render API com o token da sessão. O Next na Vercel não executa
 *   pipeline, não tem segredo de provider e não depende de filesystem local.
 * As duas implementações devolvem os MESMOS view models (montados pela mesma camada application/).
 */

export interface V2Bootstrap {
  config: PublicAppConfig;
  estimates: V2EstimateView[];
  avatars: AvatarView[];
  recent: ProjectCard[];
}

export interface SettingsData {
  config: PublicAppConfig;
  voices: VoiceProfileView[];
  matrix: ReturnType<ReturnType<typeof getRuntime>["deps"]["service"]["ugcSpeechMatrix"]> | null;
  presets: PresetSummary[];
}

export interface ReadBackend {
  readonly mode: "local" | "cloud";
  bootstrap(recent?: number): Promise<V2Bootstrap>;
  projects(filter: ProjectFilter): Promise<ProjectCard[]>;
  project(id: string): Promise<ActionResult<{ view: CampaignView; v2: ProjectV2View | null }>>;
  avatars(): Promise<AvatarView[]>;
  avatar(id: string): Promise<AvatarView | undefined>;
  /** L8.7: perfil (revisões + uso nos projetos), só leitura. */
  avatarDetail(id: string): Promise<AvatarDetailView | undefined>;
  voices(): Promise<VoiceProfileView[]>;
  settings(): Promise<SettingsData>;
  /** L8.1: presença do worker. Local = o próprio Next gera (estado "local"). */
  worker(): Promise<WorkerStatusView>;
  /** L8.2: créditos derivados do ledger (não configurado = { configured: false }). */
  credits(): Promise<CreditsResult>;
  creditsSummary(): Promise<CreditsSummary | null>;
  /** L8.8.1: leitura LEVE do shell (projetos resumidos priorizados, avatares, saldo). */
  shell(): Promise<ShellSummary>;
}

/** Backend fora do ar: a tela mostra "Serviço temporariamente indisponível." (nada técnico). */
export class ServiceUnavailableError extends Error {
  override name = "ServiceUnavailableError";
  constructor() {
    super("Serviço temporariamente indisponível.");
  }
}

export const UNAVAILABLE_RESULT = { ok: false as const, error: { code: "unavailable" as const, title: "Serviço temporariamente indisponível.", message: "Tente de novo em instantes.", retryable: true } };
export const SESSION_RESULT = { ok: false as const, error: { code: "auth" as const, title: "Sessão expirada", message: "Entre de novo para continuar.", retryable: true } };

class LocalBackend implements ReadBackend {
  readonly mode = "local" as const;
  private get deps() { return getRuntime().deps; }

  async bootstrap(recent = 8): Promise<V2Bootstrap> {
    const [avatars, cards] = await Promise.all([listAvatarViews(this.deps), listProjectCards(this.deps, recent)]);
    return { config: getPublicConfig(), estimates: getV2Estimates(), avatars, recent: cards };
  }
  async projects(filter: ProjectFilter) { return (await listProjectCards(this.deps)).filter((c) => matchesFilter(c, filter)); }
  async project(id: string) {
    const result = await getCampaignView(this.deps, id);
    return result.ok ? { ok: true as const, value: { view: result.value, v2: result.value.uxVersion === 2 ? buildProjectV2View(result.value) : null } } : result;
  }
  avatars() { return listAvatarViews(this.deps); }
  avatar(id: string) { return getAvatarView(this.deps, id); }
  avatarDetail(id: string) { return getAvatarDetail(this.deps, id); }
  voices() { return listVoiceProfileViews(this.deps); }
  async settings(): Promise<SettingsData> {
    return { config: getPublicConfig(), voices: await listVoiceProfileViews(this.deps), matrix: this.deps.service.ugcSpeechMatrix() ?? null, presets: getPresetSummaries() };
  }
  async worker(): Promise<WorkerStatusView> { return { state: "local", lastSeenAt: null }; }
  credits() { return loadCreditsView(this.deps, getRuntime().config.credits, getV2Estimates()); }
  async creditsSummary() { return creditsSummary(await this.credits()); }
  shell() { return buildShellSummary(this.deps, getRuntime().config.credits, getV2Estimates()); }
}

/** Chamada HTTPS à Render API. Erro de rede/5xx de infraestrutura → ServiceUnavailableError. */
export async function apiFetch<T>(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const env = loadFrontendEnv();
  if (!env.apiBaseUrl) throw new ServiceUnavailableError();
  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ServiceUnavailableError();
  }
  if (response.status === 502 || response.status === 503 || response.status === 504) throw new ServiceUnavailableError();
  const json = (await response.json().catch(() => undefined)) as T | undefined;
  if (json === undefined) throw new ServiceUnavailableError();
  return { status: response.status, json };
}

class RemoteBackend implements ReadBackend {
  readonly mode = "cloud" as const;
  constructor(private readonly token: string) {}

  private async read<T>(path: string): Promise<T> {
    const { json } = await apiFetch<{ ok: boolean; value: T }>(this.token, "GET", path);
    if (!json.ok) throw new ServiceUnavailableError();
    return json.value;
  }
  bootstrap(recent = 8) { return this.read<V2Bootstrap>(`/v1/bootstrap?recent=${recent}`); }
  projects(filter: ProjectFilter) { return this.read<ProjectCard[]>(`/v1/projects?filter=${encodeURIComponent(filter)}`); }
  async project(id: string) {
    return (await apiFetch<ActionResult<{ view: CampaignView; v2: ProjectV2View | null }>>(this.token, "GET", `/v1/projects/${encodeURIComponent(id)}`)).json;
  }
  avatars() { return this.read<AvatarView[]>("/v1/avatars"); }
  async avatar(id: string) {
    const { status, json } = await apiFetch<{ ok: boolean; value: AvatarView }>(this.token, "GET", `/v1/avatars/${encodeURIComponent(id)}`);
    return status === 404 || !json.ok ? undefined : json.value;
  }
  async avatarDetail(id: string) {
    const { status, json } = await apiFetch<{ ok: boolean; value: AvatarDetailView }>(this.token, "GET", `/v1/avatars/${encodeURIComponent(id)}/detail`);
    return status === 404 || !json.ok ? undefined : json.value;
  }
  voices() { return this.read<VoiceProfileView[]>("/v1/voices"); }
  settings() { return this.read<SettingsData>("/v1/settings"); }
  worker() { return this.read<WorkerStatusView>("/v1/worker"); }
  credits() { return this.read<CreditsResult>("/v1/credits"); }
  creditsSummary() { return this.read<CreditsSummary | null>("/v1/credits?summary=1"); }
  shell() { return this.read<ShellSummary>("/v1/shell"); }
}

/** Leitura de página: backend fora do ar vira { ok: false } para a tela "indisponível". */
export async function loadOr<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) return { ok: false };
    throw error;
  }
}

/** Backend com token já obtido (route handlers): `undefined` = local. */
export function getBackendFor(token: string | undefined): ReadBackend {
  return token === undefined || runtimeMode() === "local" ? new LocalBackend() : new RemoteBackend(token);
}

/** Para Server Components. No cloud, sem sessão → login (redirect). */
export async function getBackend(currentPath: string): Promise<ReadBackend> {
  if (runtimeMode() === "local") return new LocalBackend();
  return new RemoteBackend(await requireAccessToken(currentPath));
}

/**
 * Para Server Actions/route handlers no cloud: executa na API com o token da sessão.
 * Sem sessão → resultado "Sessão expirada"; API fora → "Serviço temporariamente indisponível.".
 */
export async function remoteAction<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ActionResult<T>> {
  const token = await accessToken();
  if (!token) return SESSION_RESULT;
  try {
    return (await apiFetch<ActionResult<T>>(token, method, path, body, headers)).json;
  } catch (error) {
    if (error instanceof ServiceUnavailableError) return UNAVAILABLE_RESULT;
    throw error;
  }
}

