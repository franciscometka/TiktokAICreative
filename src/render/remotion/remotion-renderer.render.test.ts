import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getVideoMetadata } from "@remotion/renderer";
import { describe, expect, it } from "vitest";
import { RenderManifestSchema, type RenderManifest } from "@/domain/render";
import { makePng } from "@/test/png";
import { makeWav } from "@/test/wav";
import { RemotionRenderer } from "./remotion-renderer";

/*
 * Teste PESADO (fora do `npm test`): renderiza um MP4 REAL de 3s em 1080x1920 com Remotion.
 * Rodar com: npm run test:render  (na 1ª vez baixa o Chrome Headless Shell do Remotion).
 */

const RUN = `run_${Date.now()}`;
const ROOT = join("outputs", ".test-render", RUN);
const UPLOADS = join(ROOT, "uploads");
const RENDERS = join(ROOT, "renders");

async function fixture(): Promise<RenderManifest> {
  await mkdir(join(UPLOADS, "prod_test"), { recursive: true });
  const imageUri = `${UPLOADS.replaceAll("\\", "/")}/prod_test/img_00000000-0000-0000-0000-000000000001.png`;
  await writeFile(imageUri, makePng(600, 900));
  return RenderManifestSchema.parse({
    campaignId: "campaign_render_test",
    creativeId: "creative_render_test",
    assets: [
      { sceneId: "s1", kind: "generated_video", uri: "mock://video/1.mp4", startSeconds: 0, durationSeconds: 1, motion: "none", shotType: "close_up", onScreenText: "Cena IA", visualSource: "generated_video", visualDescription: "close do produto" },
      { sceneId: "s2", kind: "product_image", uri: imageUri, startSeconds: 1, durationSeconds: 1, motion: "ken_burns", shotType: "product_detail", transition: "fade", onScreenText: "Parede dupla", visualSource: "product_image" },
      { sceneId: "s3", kind: "text_card", uri: null, startSeconds: 2, durationSeconds: 1, motion: "none", shotType: "text_card", transition: "cut", onScreenText: "Água gelada o dia todo", visualSource: "text_card" },
    ],
    audio: [{ kind: "narration", uri: "mock://audio/1.mp3", startSeconds: 0, durationSeconds: 3 }],
    captions: [
      { text: "Você precisa ver isso", startSeconds: 0, endSeconds: 1 },
      { text: "Gelada até a noite, ação!", startSeconds: 1, endSeconds: 2 },
    ],
    overlays: { productName: "Garrafa Térmica", priceBrl: 79.9, callToAction: "Toca no carrinho e garante a sua", hook: "Sua água esquenta antes do almoço?" },
    duration: 3,
    generatedVideoSeconds: 1,
    output: { width: 1080, height: 1920, fps: 30, container: "mp4", path: `${RENDERS}/campaign_render_test/creative_render_test` },
  });
}

/** WAV PCM 16-bit mono com trechos de silêncio (fala simulada por tom) — fixture local, sem TTS. */
function speechWav(seconds: number, silent: [number, number][], sampleRate: number): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const quiet = silent.some(([a, b]) => t >= a && t < b);
    data.writeInt16LE(quiet ? 0 : Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 9000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8, "ascii"); header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "ascii"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("RemotionRenderer (render real curto)", () => {
  it("gera MP4 1080x1920 de 3s, registra manifest, avisos e não sobrescreve versões", async () => {
    const manifest = await fixture();
    const renderer = new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
    const progress: number[] = [];

    const first = await renderer.render(manifest, { onProgress: (p) => progress.push(p.renderedFrames) });
    expect(first.renderId).toBe("v1");
    expect(first.outputUri).toBe(`${RENDERS.replaceAll("\\", "/")}/campaign_render_test/creative_render_test/v1/final.mp4`);
    expect(first.totalFrames).toBe(90);
    const info = await stat(first.outputUri);
    expect(info.size).toBeGreaterThan(10_000);
    expect(first.sizeBytes).toBe(info.size);

    const meta = await getVideoMetadata(first.outputUri);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.fps).toBe(30);
    expect(meta.durationInSeconds).toBeGreaterThan(2.9);
    expect(meta.durationInSeconds).toBeLessThan(3.1);
    expect(meta.codec).toBe("h264");
    expect(meta.pixelFormat).toBe("yuv420p");
    expect(meta.audioCodec).toBeNull(); // sem trilha de áudio (áudio ainda é mock)
    expect(progress.length).toBeGreaterThan(0);

    expect(first.warnings.map((w) => w.code).sort()).toEqual(["audio_unavailable", "generated_video_placeholder"]);
    const saved = JSON.parse(await readFile(first.manifestUri!, "utf8"));
    expect(saved).toMatchObject({ renderId: "v1", fps: 30, width: 1080, height: 1920, durationInFrames: 90 });
    // Nada de URL efêmera nem caminho absoluto no registro.
    expect(JSON.stringify(saved)).not.toContain("127.0.0.1");
    expect(saved.props.scenes[1].image.src).toMatch(/^asset:outputs\//);

    const second = await renderer.render(manifest, { preferredVersion: 1 });
    expect(second.renderId).toBe("v2");
    expect((await stat(first.outputUri)).size).toBe(info.size);
  }, 600_000);

  it("com narração real (fixture WAV local, sem ElevenLabs) o MP4 sai com trilha AAC", async () => {
    const base = await fixture();
    const audioUri = `${UPLOADS.replaceAll("\\", "/")}/prod_test/narration_fixture.wav`;
    await writeFile(audioUri, makeWav(2.5));
    const manifest = RenderManifestSchema.parse({
      ...base,
      creativeId: "creative_render_audio",
      output: { ...base.output, path: `${RENDERS}/campaign_render_test/creative_render_audio` },
      audio: [{ kind: "narration", uri: audioUri, startSeconds: 0, durationSeconds: 2.5, isMock: false, speechEndSeconds: 2.4 }],
      captionSource: "alignment",
    });
    const renderer = new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
    const result = await renderer.render(manifest);

    const meta = await getVideoMetadata(result.outputUri);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
    expect(meta.fps).toBe(30);
    expect(meta.codec).toBe("h264");
    expect(meta.audioCodec).toBe("aac");
    expect(result.warnings.map((w) => w.code)).not.toContain("audio_unavailable");
    const saved = JSON.parse(await readFile(result.manifestUri!, "utf8"));
    expect(saved.output.audio).toBe("aac");
    expect(saved.props.audio[0].src).toBe(`asset:${audioUri}`);
  }, 600_000);

  it("Editor V2: A-rolls contínuos (áudio do clipe) + B-roll overlay do frame de referência → MP4 com AAC", async () => {
    // 1) Clipe-fonte REAL local (h264 + AAC) gerado pelo próprio Remotion a partir de fixtures.
    const base = await fixture();
    const audioUri = `${UPLOADS.replaceAll("\\", "/")}/prod_test/aroll_fixture.wav`;
    await writeFile(audioUri, makeWav(3));
    const source = await new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null }).render(RenderManifestSchema.parse({
      ...base, creativeId: "creative_aroll_source", output: { ...base.output, path: `${RENDERS}/campaign_render_test/creative_aroll_source` },
      audio: [{ kind: "narration", uri: audioUri, startSeconds: 0, durationSeconds: 3, isMock: false }],
    }));
    // 2) Dois A-rolls (mesmo arquivo) + referência PNG; plano editorial do mock Econômico.
    const videos = join(ROOT, "videos");
    await mkdir(videos, { recursive: true });
    const clipUri = `${videos.replaceAll("\\", "/")}/aroll.mp4`;
    await writeFile(clipUri, await readFile(source.outputUri));
    const referenceUri = `${UPLOADS.replaceAll("\\", "/")}/prod_test/reference.png`;
    await writeFile(referenceUri, makePng(1080, 1920));
    const { buildMockDraft } = await import("@/ai/mock-planner");
    const { hydrateCampaignPlan } = await import("@/ai/hydrate");
    const { applyUgcEditorial } = await import("@/ai/ugc-editorial");
    const { SIMPLE_UGC_QUALITY_PRESETS } = await import("@/config/simple-presets");
    const { buildEditedRenderManifest } = await import("../edit-manifest");
    const { product } = await import("@/test/fixtures");
    const settings = SIMPLE_UGC_QUALITY_PRESETS.economy;
    const draft = buildMockDraft({ product: product(), styles: ["ugc"], creativeCount: 1, settings, creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech", ugcPresenterOnly: false });
    let n = 0;
    const plan = applyUgcEditorial(hydrateCampaignPlan(draft, product(), (prefix) => `${prefix}_${++n}`).creatives[0]!, { quality: "economy", finalRange: settings.finalVideoSeconds }).plan;
    const clips = new Map(plan.scenes.filter((s) => s.edit?.role === "aroll").map((s) => [s.id, {
      uri: clipUri, actualSeconds: 3, generatedSeconds: 4,
      audioSilence: { source: "ffmpeg_silencedetect" as const, noiseDb: -38, minSilenceSeconds: 0.12,
        intervals: [{ startSeconds: 0.2, endSeconds: 0.4 }, { startSeconds: 2.5, endSeconds: 2.7 }] },
    }]));
    const manifest = buildEditedRenderManifest({ campaignId: "campaign_render_test", plan: { ...plan, id: "creative_render_v2" }, product: product(), clips, referenceImageUri: referenceUri, outputDir: ROOT.replaceAll("\\", "/") });
    const renderer = new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS, videos], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
    const result = await renderer.render(manifest);
    const meta = await getVideoMetadata(result.outputUri);
    expect(meta.durationInSeconds).toBeGreaterThan(manifest.edit!.durationSeconds - 0.1);
    expect(meta.durationInSeconds).toBeLessThan(manifest.edit!.durationSeconds + 0.1);
    expect(meta.audioCodec).toBe("aac"); // áudio vem do A-roll (fala nativa), sem narração separada
    const saved = JSON.parse(await readFile(result.manifestUri!, "utf8"));
    expect(saved.props.edit.visuals.some((v: { role: string }) => v.role === "broll")).toBe(true);
    expect(saved.props.edit.audio).toHaveLength(2);
    expect(saved.props.edit.audio[0].trimBeforeFrames).toBeGreaterThan(0);
    expect(saved.props.edit.audio[1].startFrame).toBe(saved.props.edit.audio[0].startFrame + saved.props.edit.audio[0].durationFrames);
    expect(saved.props.edit.captions.length).toBeGreaterThan(0);
    expect(saved.props.edit.cta.endFrame - saved.props.edit.cta.startFrame).toBe(54); // 1,8s × 30fps
    expect(saved.props.edit.cta.endFrame).toBe(saved.props.durationInFrames);
  }, 900_000);

  it("Presenter Only (V3): só A-rolls, áudio 44,1 kHz mono das fontes sai AAC 48 kHz estéreo, timeline contínua e validada", async () => {
    // Clipe-fonte REAL (h264 + AAC) com fala simulada: respiração 0–0,3s, pausa 1,0–1,15s e silêncio final 2,0–3,0s.
    const base = await fixture();
    const wavUri = `${UPLOADS.replaceAll("\\", "/")}/prod_test/presenter_fixture.wav`;
    await writeFile(wavUri, speechWav(3, [[0, 0.3], [1.0, 1.15], [2.0, 3.0]], 44_100));
    const source = await new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null }).render(RenderManifestSchema.parse({
      ...base, creativeId: "creative_presenter_source", output: { ...base.output, path: `${RENDERS}/campaign_render_test/creative_presenter_source` },
      audio: [{ kind: "narration", uri: wavUri, startSeconds: 0, durationSeconds: 3, isMock: false }],
    }));
    const videos = join(ROOT, "videos-v3");
    await mkdir(videos, { recursive: true });
    const clipUri = `${videos.replaceAll("\\", "/")}/presenter.mp4`;
    await writeFile(clipUri, await readFile(source.outputUri));
    const { analyzeAudioSilence } = await import("../audio-silence");
    const silence = await analyzeAudioSilence(clipUri, 3, { noiseDb: -38, minSeconds: 0.1 });
    expect(silence?.intervals.length).toBeGreaterThanOrEqual(2);
    const { buildMockDraft } = await import("@/ai/mock-planner");
    const { hydrateCampaignPlan } = await import("@/ai/hydrate");
    const { applyPresenterOnly } = await import("@/ai/ugc-presenter-only");
    const { SIMPLE_UGC_QUALITY_PRESETS } = await import("@/config/simple-presets");
    const { buildEditedRenderManifest } = await import("../edit-manifest");
    const { auditEditTimeline } = await import("../presenter-edit-plan");
    const { probeRenderedMedia } = await import("./media-probe");
    const { product } = await import("@/test/fixtures");
    const draft = buildMockDraft({ product: product(), styles: ["ugc"], creativeCount: 1, settings: SIMPLE_UGC_QUALITY_PRESETS.economy, creativeMode: "ai_ugc", ugcAudioStrategy: "native_speech" });
    let n = 0;
    const plan = applyPresenterOnly(hydrateCampaignPlan(draft, product(), (prefix) => `${prefix}_${++n}`).creatives[0]!).plan;
    const clips = new Map(plan.scenes.map((s) => [s.id, { uri: clipUri, actualSeconds: 3, generatedSeconds: 8, ...(silence ? { audioSilence: silence } : {}) }]));
    const manifest = buildEditedRenderManifest({ campaignId: "campaign_render_test", plan: { ...plan, id: "creative_render_v3" }, product: product(), clips, outputDir: ROOT.replaceAll("\\", "/") });
    expect(manifest.edit!.version).toBe(3);
    expect(auditEditTimeline(manifest.edit!)).toEqual([]);
    const renderer = new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS, videos], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
    const result = await renderer.render(manifest);
    const probe = await probeRenderedMedia(result.outputUri);
    expect(probe?.audio).toMatchObject({ codec: "aac", sampleRate: 48_000, channels: 2 });
    expect(Math.abs(probe!.durationSeconds - manifest.edit!.durationSeconds)).toBeLessThan(1 / 30 + 0.05);
    const saved = JSON.parse(await readFile(result.manifestUri!, "utf8"));
    expect(saved.mediaCheck.issues).toEqual([]);
    expect(saved.props.edit.version).toBe(3);
    expect(saved.props.edit.visuals.every((v: { role: string; kind: string }) => v.role === "aroll" && v.kind === "video")).toBe(true);
    const audio = saved.props.edit.audio as { startFrame: number; durationFrames: number }[];
    audio.forEach((track, i) => { if (i > 0) expect(track.startFrame).toBe(audio[i - 1]!.startFrame + audio[i - 1]!.durationFrames); });
    expect(audio.at(-1)!.startFrame + audio.at(-1)!.durationFrames).toBe(saved.props.durationInFrames);
    expect(manifest.edit!.finalTailSeconds).toBeGreaterThanOrEqual(0.8);
    expect(saved.props.edit.captions.every((c: { lines: string[] }) => c.lines.length <= 2)).toBe(true);
    // Lote 6.2: junções renderizadas com transição natural (≤ 6 frames); abertura sem efeito.
    const fx = (saved.props.edit.visuals as { transitionFx: { frames: number; blendFrames: number } | null }[]).map((v) => v.transitionFx);
    expect(fx[0]).toBeNull();
    expect(fx.slice(1).every((f) => f !== null && f.frames <= 6 && f.blendFrames <= 4)).toBe(true);
  }, 900_000);

  it("recusa asset fora das pastas autorizadas sem gerar arquivo", async () => {
    const manifest = await fixture();
    const evil = { ...manifest, assets: manifest.assets.map((a, i) => (i === 1 ? { ...a, uri: "package.json" } : a)) };
    const renderer = new RemotionRenderer({ rendersDir: RENDERS, allowedAssetRoots: [UPLOADS], browserExecutable: process.env.RENDER_BROWSER_EXECUTABLE ?? null });
    await expect(renderer.render(evil)).rejects.toMatchObject({ name: "AssetSecurityError" });
  });
});
