import { QUALITY_PRESETS } from "@/config/quality-presets";
import { QualitySettingsSchema, type GenerationQuality, type QualitySettings } from "@/domain/quality";

export class QualitySettingsError extends Error {
  override name = "QualitySettingsError";
}

/** Resolve o nível de qualidade para configurações concretas. "custom" exige settings explícitos. */
export function resolveQualitySettings(
  quality: GenerationQuality,
  custom?: QualitySettings,
): QualitySettings {
  if (quality === "custom") {
    if (!custom) throw new QualitySettingsError('Qualidade "custom" exige customSettings');
    return QualitySettingsSchema.parse({ ...custom, quality: "custom" });
  }
  return QUALITY_PRESETS[quality];
}
