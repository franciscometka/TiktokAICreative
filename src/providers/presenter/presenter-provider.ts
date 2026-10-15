import type { AvatarPreset } from "@/domain/presenter";
import type { CostQuote, MediaResult, ProviderDescriptor, ProviderJobStatus } from "../types";
export interface PresenterRequest { avatarPresetId: AvatarPreset; audio: Uint8Array; durationSeconds: number }
export interface PresenterRef { providerJobId: string; requestId?: string; requestedDurationSeconds: number }
/** Audio-driven presenter only. No text-to-speech and no generic image-to-video. */
export interface PresenterProvider {
  readonly descriptor: ProviderDescriptor;
  estimateCost(seconds: number): CostQuote;
  submit(request: PresenterRequest): Promise<PresenterRef>;
  getStatus(ref: PresenterRef): Promise<ProviderJobStatus>;
  downloadResult(ref: PresenterRef): Promise<MediaResult>;
}
