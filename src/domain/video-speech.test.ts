import { describe, expect, it } from "vitest";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import { PRICING_TABLE } from "@/config/pricing";
import { ugcPricingRefs } from "@/config/ugc-models";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { FAKE_KREA_KEY, kreaFake } from "@/test/krea-fake";
import { UgcVideoProviderVeo, type VeoUgcVideoTransport } from "@/providers/ugc/google-ugc-providers";
import { KreaHttpClient } from "@/providers/ugc/krea-http";
import { UgcVideoProviderKrea } from "@/providers/ugc/krea-ugc-providers";
import { MockUgcVideoProvider } from "@/providers/ugc/mock-ugc-providers";
import { speechCapabilities } from "@/providers/ugc/ugc-providers";
import { masterAudioSegments, resolveVoiceLock, VOICE_LOCK_UNAVAILABLE, VoiceLockUnavailableError, type SpeechCapabilities } from "./video-speech";

const catalog = new StaticPricingCatalog(PRICING_TABLE);

const NATIVE: SpeechCapabilities = { supportsNativeAudio: true, supportsExternalAudio: false, supportsLipSync: false, supportsIdentityReference: false, supportsProductReference: false };
const LIPSYNC: SpeechCapabilities = { supportsNativeAudio: false, supportsExternalAudio: true, supportsLipSync: true, supportsIdentityReference: false, supportsProductReference: false };

describe("Voice Lock (Lote 6)", () => {
  it("LOCKED_VOICE só quando o provider aceita áudio externo + lip-sync de verdade", () => {
    expect(resolveVoiceLock({ requested: "auto", provider: "lipsync", capabilities: LIPSYNC, voiceProfileId: "voice_clara" })).toMatchObject({ strategy: "locked_voice", speech: "external_lipsync", available: true, voiceProfileId: "voice_clara" });
  });

  it("pedido explícito de Voice Lock sem suporte: erro claro, nenhum fallback silencioso", () => {
    expect(() => resolveVoiceLock({ requested: "locked", provider: "krea", capabilities: NATIVE })).toThrow(VoiceLockUnavailableError);
    expect(() => resolveVoiceLock({ requested: "locked", provider: "krea", capabilities: NATIVE })).toThrow(VOICE_LOCK_UNAVAILABLE);
  });

  it("automático sem suporte: fala nativa EXPLÍCITA, com o motivo registrado", () => {
    const decision = resolveVoiceLock({ requested: "auto", provider: "google", capabilities: NATIVE });
    expect(decision).toMatchObject({ strategy: "provider_native", speech: "native", available: false });
    expect(decision.reason).toContain(VOICE_LOCK_UNAVAILABLE);
  });

  it("provider que só faz lip-sync recusa \"voz do próprio vídeo\" (não inventa fala nativa)", () => {
    expect(() => resolveVoiceLock({ requested: "native", provider: "lipsync", capabilities: LIPSYNC })).toThrow(/não gera fala nativa/);
  });

  it("capability matrix: Krea/Veo declaram só áudio nativo (sem Voice Lock); mock lip-sync declara áudio externo", () => {
    const krea = new UgcVideoProviderKrea(catalog.requireOne(kreaUgcPricingRefs("high").video), new KreaHttpClient(FAKE_KREA_KEY, kreaFake().fetch), async () => ({ data: new Uint8Array(), mimeType: "image/png" }));
    expect(speechCapabilities(krea)).toEqual(NATIVE);
    const veo = new UgcVideoProviderVeo(catalog.requireOne(ugcPricingRefs("high").video), {} as VeoUgcVideoTransport);
    expect(speechCapabilities(veo)).toMatchObject({ supportsNativeAudio: true, supportsExternalAudio: false, supportsLipSync: false, supportsIdentityReference: false, supportsProductReference: true });
    const pricing = catalog.requireOne(ugcPricingRefs("high").video);
    expect(speechCapabilities(new MockUgcVideoProvider(pricing, "native_speech"))).toEqual(NATIVE);
    expect(speechCapabilities(new MockUgcVideoProvider(pricing, "external_lipsync"))).toMatchObject({ supportsExternalAudio: true, supportsLipSync: true, supportsNativeAudio: false });
  });

  it("áudio mestre é dividido logicamente: intervalos contíguos de 0 à duração", () => {
    const proportional = masterAudioSegments({ durationSeconds: 30, segmentWordCounts: [10, 20, 30], sceneIds: ["a", "b", "c"] });
    expect(proportional.map((s) => [s.startSeconds, s.endSeconds])).toEqual([[0, 5], [5, 15], [15, 30]]);
    const words = Array.from({ length: 6 }, (_, i) => ({ startSeconds: i, endSeconds: i + 0.6 }));
    const aligned = masterAudioSegments({ durationSeconds: 6.5, segmentWordCounts: [3, 3], sceneIds: ["a", "b"], words });
    // Corte no meio da pausa entre a 3ª palavra (fim 2,6) e a 4ª (início 3).
    expect(aligned[0]!.endSeconds).toBe(2.8);
    expect(aligned[1]).toMatchObject({ startSeconds: 2.8, endSeconds: 6.5 });
  });
});
