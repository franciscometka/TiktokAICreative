import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderManifestSchema } from "@/domain/render";
import { narrationTiming } from "@/speech/alignment";
import { buildNarrationScript } from "@/speech/narration-script";
import { makeMp3 } from "@/test/elevenlabs-fake";
import { product, simplePlan } from "@/test/fixtures";
import { makeWav } from "@/test/wav";
import { AssetCorruptedError, AssetResolver } from "./asset-resolver";
import { buildCompositionProps } from "./composition-props";
import { buildRenderManifest } from "./manifest";

const plan = simplePlan();
const AUDIO = "outputs/audio/campaign_1/creative_1/v1/narration.mp3";

function timing(spc = 0.05) {
  const script = buildNarrationScript(plan);
  const chars = script.spoken.split("");
  return narrationTiming(script, {
    characters: chars,
    startSeconds: chars.map((_, i) => i * spc),
    endSeconds: chars.map((_, i) => (i + 1) * spc),
  });
}

function manifest(narration?: Parameters<typeof buildRenderManifest>[0]["narration"]) {
  const sceneVideos = new Map(plan.scenes.filter((s) => s.requiresGeneratedVideo).map((s) => [s.id, `mock://video/${s.id}.mp4`]));
  return buildRenderManifest({ campaignId: "campaign_1", plan, product: product(), sceneVideos, narration, outputDir: "outputs" });
}

describe("manifest com narração real", () => {
  it("legendas vêm do timing real (captionSource = alignment) e seguem a fala", () => {
    const t = timing();
    const m = manifest({ uri: AUDIO, durationSeconds: 20, isMock: false, timing: t });
    expect(m.captionSource).toBe("alignment");
    expect(m.captions[0]!.startSeconds).toBe(t.words[0]!.startSeconds);
    expect(m.audio[0]).toMatchObject({ uri: AUDIO, isMock: false, speechEndSeconds: t.speechEndSeconds });
    expect(m.warnings.map((w) => w.code)).not.toContain("captions_estimated");
  });

  it("sem timing: fallback estimado do Lote 3, com aviso quando o áudio é real", () => {
    const real = manifest({ uri: AUDIO, durationSeconds: 20, isMock: false });
    expect(real.captionSource).toBe("estimated");
    expect(real.warnings.map((w) => w.code)).toContain("captions_estimated");
    const mock = manifest({ uri: "mock://audio/1.mp3", durationSeconds: 20 });
    expect(mock.captionSource).toBe("estimated");
    expect(mock.audio[0]!.isMock).toBe(true);
    expect(mock.warnings.map((w) => w.code)).not.toContain("captions_estimated");
  });

  it("extensão estende a última cena e a duração; nada é cortado", () => {
    const base = manifest();
    const ext = manifest({ uri: AUDIO, durationSeconds: 22, isMock: false, timing: timing(), extendSeconds: 1.5 });
    expect(ext.duration).toBeCloseTo(base.duration + 1.5, 6);
    expect(ext.extendedSeconds).toBe(1.5);
    const last = ext.assets[ext.assets.length - 1]!;
    expect(last.durationSeconds).toBeCloseTo(base.assets[base.assets.length - 1]!.durationSeconds + 1.5, 6);
    expect(ext.warnings.map((w) => w.code)).toContain("timeline_extended");
  });

  it("manifests antigos (sem os campos novos) continuam válidos", () => {
    const legacy = { ...manifest() } as Record<string, unknown>;
    delete legacy.captionSource;
    delete legacy.extendedSeconds;
    const parsed = RenderManifestSchema.parse(legacy);
    expect(parsed.captionSource).toBe("estimated");
    expect(parsed.extendedSeconds).toBe(0);
  });
});

describe("composição com e sem áudio", () => {
  let cwd: string;
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "narration-render-"));
    await mkdir(join(cwd, "outputs/audio/campaign_1/creative_1/v1"), { recursive: true });
    await writeFile(join(cwd, AUDIO), makeMp3(40));
    await writeFile(join(cwd, "outputs/audio/campaign_1/creative_1/v1/fixture.wav"), makeWav(0.5));
    await writeFile(join(cwd, "outputs/audio/campaign_1/creative_1/v1/fake.mp3"), "não é mp3");
  });
  afterAll(() => rm(cwd, { recursive: true, force: true }));
  const urlFor = (uri: string) => `http://127.0.0.1:1/assets/${encodeURIComponent(uri)}`;

  it("áudio real autorizado entra como trilha; sem aviso de 'sem som'", async () => {
    const resolver = new AssetResolver(["outputs/audio"], cwd);
    const m = manifest({ uri: AUDIO, durationSeconds: 1, isMock: false, timing: timing() });
    const assets = new Map([[AUDIO, await resolver.resolve(AUDIO)]]);
    for (const a of m.assets) if (a.uri) assets.set(a.uri, a.uri.startsWith("mock://") ? { kind: "mock", uri: a.uri } : { kind: "missing", uri: a.uri });
    const { props, warnings } = buildCompositionProps({ manifest: m, assets, urlFor });
    expect(props.audio).toEqual([{ src: urlFor(AUDIO), startFrame: 0 }]);
    expect(warnings.map((w) => w.code)).not.toContain("audio_unavailable");
  });

  it("mock ou arquivo ausente: sem trilha e com aviso (comportamento do Lote 3)", () => {
    const mock = manifest({ uri: "mock://audio/1.mp3", durationSeconds: 1 });
    const r1 = buildCompositionProps({ manifest: mock, assets: new Map(), urlFor });
    expect(r1.props.audio).toEqual([]);
    expect(r1.warnings.find((w) => w.code === "audio_unavailable")?.message).toMatch(/mock/);
    const missing = manifest({ uri: AUDIO, durationSeconds: 1, isMock: false });
    const r2 = buildCompositionProps({ manifest: missing, assets: new Map([[AUDIO, { kind: "missing", uri: AUDIO }]]), urlFor });
    expect(r2.props.audio).toEqual([]);
    expect(r2.warnings.find((w) => w.code === "audio_unavailable")?.message).toMatch(/não encontrado/);
  });

  it("resolver aceita MP3/WAV verdadeiros e recusa conteúdo falso ou fora das raízes", async () => {
    const resolver = new AssetResolver(["outputs/audio"], cwd);
    expect(await resolver.resolve(AUDIO)).toMatchObject({ kind: "file", media: "audio", contentType: "audio/mpeg" });
    expect(await resolver.resolve("outputs/audio/campaign_1/creative_1/v1/fixture.wav")).toMatchObject({ media: "audio", contentType: "audio/wav" });
    await expect(resolver.resolve("outputs/audio/campaign_1/creative_1/v1/fake.mp3")).rejects.toBeInstanceOf(AssetCorruptedError);
    await expect(resolver.resolve("outputs/audio/../segredo.mp3")).rejects.toMatchObject({ name: "AssetSecurityError" });
    await expect(resolver.resolve("C:/Windows/media/tada.wav")).rejects.toMatchObject({ name: "AssetSecurityError" });
  });
});
