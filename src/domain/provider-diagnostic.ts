import { z } from "zod";

export const ProviderDiagnosticSchema = z.object({
  kind: z.enum(["invalid_request", "authentication", "quota", "provider", "http", "timeout", "connection", "invalid_response"]),
  httpStatus: z.int().min(100).max(599).optional(),
  requestId: z.string().max(200).optional(),
  providerCode: z.string().max(500).optional(),
  providerStatus: z.string().max(500).optional(),
  providerMessage: z.string().max(500).optional(),
  billing: z.enum(["rejected", "unconfirmed", "confirmed"]),
  /**
   * Fase da operação no provider (Lote 5.4): none = rejeitada antes de existir operação;
   * created = operação/resposta confirmada e falhou depois (pode haver cobrança);
   * unknown = timeout/rede após envio (incerto; nunca reenviar automaticamente).
   */
  operation: z.enum(["none", "created", "unknown"]).optional(),
});
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
