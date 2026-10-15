import { z } from "zod";
import { ProviderDiagnosticSchema } from "./provider-diagnostic";
export const RUNWAY_AVATAR_PRESETS = ["influencer", "human-resource", "fashion-designer", "cooking-teacher", "tennis-coach", "music-superstar", "game-character", "game-character-man", "cat-character"] as const;
export const AvatarPresetSchema = z.enum(RUNWAY_AVATAR_PRESETS);
export type AvatarPreset = z.infer<typeof AvatarPresetSchema>;
export const PresenterAudioSchema = z.object({
  narrationAttemptId: z.string().min(1), narrationVersion: z.string().min(1),
  startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(),
});
export type PresenterAudio = z.infer<typeof PresenterAudioSchema>;
/** Durable intent BEFORE POST; a submitting intent without id is never resubmitted. */
export const PresenterTaskSchema = z.object({
  attemptId: z.string(), sceneId: z.string(), avatarPresetId: AvatarPresetSchema,
  state: z.enum(["submitting", "pending", "succeeded", "failed"]),
  providerJobId: z.string().optional(), requestId: z.string().optional(),
  requestedDurationSeconds: z.number().positive(), audio: PresenterAudioSchema,
  estimateId: z.string().optional(),
  estimatedCostUsd: z.number().nonnegative(), actualCostUsd: z.number().nonnegative().optional(), error: z.string().optional(), createdAt: z.string(),
  diagnostic: ProviderDiagnosticSchema.optional(),
});
export type PresenterTask = z.infer<typeof PresenterTaskSchema>;
