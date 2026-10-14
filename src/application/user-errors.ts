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
  | "over_budget_not_allowed"
  | "invalid_state"
  | "attempt_limit"
  | "not_found"
  | "corrupted"
  | "upload";

export interface UserError {
  code: UserErrorCode;
  title: string;
  message: string;
  retryable: boolean;
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
  if (named(error, "UploadValidationError")) return make("upload", "Imagem recusada", error.message);
  if (named(error, "InvalidUploadPathError")) return make("upload", "Imagem recusada", "Referência de imagem inválida.");

  console.error("[erro inesperado]", error);
  return make("unknown", "Algo deu errado", "Ocorreu um erro inesperado. Os detalhes ficaram no log do servidor.", true);
}
