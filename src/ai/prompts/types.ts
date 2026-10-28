import type { z } from "zod";

/**
 * Um prompt versionado. System prompt, mensagem do usuário e schema de saída
 * andam JUNTOS: mudar o formato de saída exige nova versão.
 */
export interface PromptDefinition<TInput, TOutput> {
  id: string;
  /** SemVer. Mudança de schema de saída = major. */
  version: string;
  status: "draft" | "active" | "deprecated";
  /** Estável (sem dados variáveis) para permitir cache do prefixo. */
  system: string;
  buildUserMessage(input: TInput): string;
  /** Schema enviado à API como saída estruturada (sem regras dependentes da entrada). */
  outputSchema: z.ZodType<TOutput>;
  /** Schema de validação final, podendo incluir regras que dependem da entrada (ex.: quantidade). */
  validationSchemaFor(input: TInput): z.ZodType<TOutput>;
  /** Normalização determinística aplicada ao JSON parseado antes da validação final. */
  normalizeParsedOutput?(value: unknown): unknown;
  maxTokensFor(input: TInput): number;
}
