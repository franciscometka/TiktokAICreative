import { requiresGeneratedVideoForVisualSource, VisualSourceSchema } from "@/domain/creative";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Normaliza somente fatos 100% derivados. Estruturas, fontes desconhecidas e campos criativos
 * permanecem intocados para que o schema final os rejeite normalmente.
 */
export function normalizeCampaignPlanDerivedFields(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.creatives)) return value;
  return {
    ...value,
    creatives: value.creatives.map((creative) => {
      if (!isRecord(creative) || !Array.isArray(creative.scenes)) return creative;
      return {
        ...creative,
        scenes: creative.scenes.map((scene) => {
          if (!isRecord(scene)) return scene;
          const source = VisualSourceSchema.safeParse(scene.visualSource);
          if (!source.success) return scene;
          return {
            ...scene,
            requiresGeneratedVideo: requiresGeneratedVideoForVisualSource(source.data),
          };
        }),
      };
    }),
  };
}
