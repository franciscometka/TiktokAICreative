import type { LlmErrorKind } from "@/ai/llm-client";
import type { CampaignErrorCode } from "@/domain/pipeline";

/**
 * Erros mostrados ao usuário: título + mensagem curta + se faz sentido tentar de novo.
 * Nunca inclui stack trace nem mensagem crua de biblioteca; o detail técnico fica no log do servidor.
 */

export type UserErrorCode =
  | CampaignErrorCode
  | "validation"
  | "planning_budget"
  | "planning_in_progress"
  | "stale_estimate"
  /** A cotação mudou depois que a tela foi aberta: nada foi autorizado; `quote` traz a nova. */
  | "quote_changed"
  | "over_budget_not_allowed"
  | "invalid_state"
  | "attempt_limit"
  | "not_found"
  | "corrupted"
  | "upload"
  | "job_in_progress"
  | "render_security"
  /** Lote 7: backend cloud fora do ar ("Serviço temporariamente indisponível."). */
  | "unavailable"
  /** Lote 7: sessão ausente/expirada no modo cloud. */
  | "auth";

export interface UserError {
  code: UserErrorCode;
  title: string;
  message: string;
  retryable: boolean;
  /** Só em `quote_changed`: a cotação atual do job, para a tela mostrar e exigir novo clique. */
  quote?: { estimatedBrl: number; maximumAuthorizedBrl: number; token: string };
}

const PLANNING: Record<CampaignErrorCode, Omit<UserError, "code">> = {
  not_configured: {
    title: "Claude não configurado",
    message:
      "O planejamento real está ativado (LLM_PROVIDER=anthropic), mas a ANTHROPIC_API_KEY não foi definida no servidor. Defina a chave em .env.local ou use LLM_PROVIDER=mock.",
    retryable: false,
  },
  auth_error: {
    title: "Chave da Anthropic recusada",
    message: "A API key foi recusada ou não tem acesso a este modelo. Verifique a chave configurada no servidor.",
    retryable: false,
  },
  rate_limited: {
    title: "Limite de requisições atingido",
    message: "A Anthropic limitou as requisições no momento. Aguarde alguns instantes e planeje novamente.",
    retryable: true,
  },
  timeout: {
    title: "O planejamento demorou demais",
    message: "A chamada ao Claude passou do tempo limite. Você pode planejar novamente.",
    retryable: true,
  },
  connection_error: {
    title: "Falha de conexão",
    message: "Não foi possível falar com a API da Anthropic. Verifique a conexão e planeje novamente.",
    retryable: true,
  },
  invalid_response: {
    title: "Resposta inválida do Claude",
    message:
      "O Claude respondeu, mas o plano não passou na validação dentro do limite de tentativas. Nenhum plano inválido foi aceito.",
    retryable: true,
  },
  stopped: {
    title: "Resposta interrompida",
    message: "A resposta do Claude foi cortada (limite de tamanho) ou recusada. Revise os dados do produto e tente de novo.",
    retryable: true,
  },
  provider_error: {
    title: "Erro no provedor do LLM",
    message: "A Anthropic retornou um erro. Você pode planejar novamente em instantes.",
    retryable: true,
  },
  interrupted: {
    title: "Planejamento interrompido",
    message:
      "O servidor parou ou reiniciou antes de o planejamento terminar. Se o Claude chegou a responder, essa chamada pode ter sido cobrada sem aparecer aqui. Planejar de novo faz uma NOVA chamada.",
    retryable: true,
  },
  unknown: {
    title: "O planejamento falhou",
    message: "Ocorreu um erro inesperado. Os detalhes ficaram no log do servidor.",
    retryable: true,
  },
};

export function planningUserError(code: CampaignErrorCode): UserError {
  return { code, ...PLANNING[code] };
}

/**
 * "Ver detalhes" da falha de planejamento: a causa REAL (ex.: "Trecho 2: fala longa demais"),
 * sanitizada — sem chaves/tokens, caminhos absolutos, URLs com parâmetros ou texto ilimitado.
 */
export function planningErrorDetails(detail: string | undefined): string | undefined {
  if (!detail?.trim()) return undefined;
  const clean = detail
    .replace(/\b(sk-ant-|sk-|AIza|Bearer\s+)[\w.-]+/gi, "[oculto]")
    .replace(/\b(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[oculto]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[oculto]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|mnt)\/)[^\s"')]+/g, "[caminho]")
    .replace(/creatives\.\d+\.scenes\.(\d+)(?:\.\w+)?/g, (_, i: string) => `Trecho ${Number(i) + 1}`)
    .replace(/creatives\.\d+\.script/g, "Roteiro")
    .replace(/creatives\.\d+\.scenes/g, "Trechos")
    .replace(/creatives\.\d+/g, "Vídeo")
    .replace(/[ \t]+/g, " ")
    .trim();
  return clean.length > 700 ? `${clean.slice(0, 699)}…` : clean;
}

function make(code: UserErrorCode, title: string, message: string, retryable = false): UserError {
  return { code, title, message, retryable };
}

/**
 * Identifica erros pelo `name` (todas as classes de erro do projeto definem `name`), não por
 * instanceof: no Next o runtime do processo é compartilhado entre camadas do bundler (páginas,
 * Server Actions, route handlers), e cada camada pode ter sua própria instância do módulo da classe.
 */
function named(error: unknown, ...names: string[]): error is Error & Record<string, unknown> {
  return error instanceof Error && names.includes(error.name);
}

/** Converte exceções conhecidas em erro de usuário. Desconhecidas são logadas no servidor. */
export function toUserError(error: unknown): UserError {
  if (named(error, "PlanningUnavailableError")) {
    const kind = error.llmErrorKind as LlmErrorKind | undefined;
    return planningUserError(kind === "missing_credentials" ? "not_configured" : "auth_error");
  }
  if (named(error, "PlanningBudgetError")) {
    return make(
      "planning_budget",
      "Orçamento insuficiente para planejar",
      "O custo máximo possível do planejamento passa do limite da campanha. Aumente o limite por campanha ou reduza a quantidade de criativos.",
    );
  }
  if (named(error, "PlanningInProgressError")) {
    return make("planning_in_progress", "Planejamento em andamento", "Aguarde o planejamento atual terminar.");
  }
  if (named(error, "QuoteChangedError")) {
    return { ...make("quote_changed", "A estimativa foi atualizada", "O valor mudou depois que a página foi aberta. Revise o novo valor antes de continuar.", true), quote: error.quote as NonNullable<UserError["quote"]> };
  }
  if (named(error, "StaleEstimateError")) {
    return make(
      "stale_estimate",
      "A estimativa mudou",
      "O custo deste criativo foi recalculado depois que a página foi aberta. Revise o novo valor antes de aprovar.",
      true,
    );
  }
  if (named(error, "OverBudgetNotAllowedError")) {
    return make(
      "over_budget_not_allowed",
      "Exceder o limite não está permitido",
      "Esta campanha não permite autorizar gastos acima do limite. Cancele ou crie uma campanha com limite maior.",
    );
  }
  if (named(error, "AttemptLimitReachedError")) {
    return make("attempt_limit", "Limite de tentativas atingido", "Esta cena já usou todas as tentativas permitidas.");
  }
  if (named(error, "UnexpectedStatusError", "InvalidTransitionError", "ApprovalRequiredError")) {
    return make(
      "invalid_state",
      "Ação não disponível agora",
      "O estado deste criativo mudou. Atualize a página para ver a situação atual.",
      true,
    );
  }
  if (named(error, "CorruptedDataError")) {
    console.error("[dados corrompidos]", error.message);
    return make(
      "corrupted",
      "Dados da campanha corrompidos",
      "Um arquivo desta campanha não pôde ser lido. Nada foi alterado; verifique a pasta de dados (DATA_DIR).",
    );
  }
  if (named(error, "NotFoundError")) {
    return make("not_found", "Campanha não encontrada", "Esta campanha não existe ou foi removida da pasta de dados.");
  }
  if (named(error, "JobInProgressError")) {
    return make("job_in_progress", "Já em andamento", "Este criativo já está sendo gerado ou renderizado. Aguarde terminar.");
  }
  if (named(error, "AssetSecurityError", "InvalidRenderPathError")) {
    console.error("[render: segurança]", error.message);
    return make("render_security", "Asset recusado", "Uma referência de arquivo do criativo não é permitida. Nada foi renderizado; veja o log do servidor.");
  }
  if (named(error, "AssetCorruptedError")) {
    console.error("[render: asset corrompido]", error.message);
    return make("corrupted", "Imagem corrompida", "Uma imagem do produto não pôde ser lida. Remova e envie de novo.");
  }
  // Product Fidelity Gate: a mensagem já é para o usuário (sem dados sensíveis).
  if (named(error, "UgcFidelityError")) return make("invalid_state", "Fidelidade do produto", error.message);
  // Correção Lote 6: avatar salvo com foto e provider sem referência de identidade — nada foi cobrado.
  if (named(error, "UgcIdentityUnsupportedError")) return make("validation", "Avatar não suportado", error.message);
  // Lote 6: Voice Lock pedido sem suporte real do provider — nunca troca de estratégia sozinho.
  if (named(error, "VoiceLockUnavailableError")) return make("validation", "Voice Lock indisponível", error.message);
  if (named(error, "UploadValidationError")) return make("upload", "Imagem recusada", error.message);
  // Lote 7 (upload cloud): falha do Storage/caminho vira mensagem de upload (causa logada no servidor).
  if (named(error, "StorageError", "AssetPathError")) {
    console.error("[upload] storage:", error.message);
    return make("upload", "Imagem recusada", "Não foi possível falar com o armazenamento de imagens. Tente de novo em instantes.", true);
  }
  // Build da Vercel sem modo cloud: a mensagem já diz o que configurar (sem segredo).
  if (named(error, "DeployMisconfiguredError")) return make("unavailable", "Deploy sem modo cloud", error.message);
  if (named(error, "InvalidUploadPathError")) return make("upload", "Imagem recusada", "Referência de imagem inválida.");

  console.error("[erro inesperado]", error);
  return make("unknown", "Algo deu errado", "Ocorreu um erro inesperado. Os detalhes ficaram no log do servidor.", true);
}
