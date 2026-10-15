import { z } from "zod";

export const ProviderDiagnosticSchema = z.object({
  kind: z.enum(["invalid_request", "authentication", "quota", "provider", "http", "timeout", "connection", "invalid_response"]),
  httpStatus: z.int().min(100).max(599).optional(),
  requestId: z.string().max(200).optional(),
  providerCode: z.string().max(500).optional(),
  providerStatus: z.string().max(500).optional(),
  providerMessage: z.string().max(500).optional(),
  billing: z.enum(["rejected", "unconfirmed", "confirmed"]),
});
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;
