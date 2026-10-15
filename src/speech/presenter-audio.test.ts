import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wav } from "@/test/presenter-fake";
import { slicePresenterAudio, alignedSceneWindows, alignedPresenterPlan } from "./presenter-audio";
import { presenterWavDuration } from "@/providers/presenter/wav";
import { simplePlan } from "@/test/fixtures";
import { prepareProductUgc } from "@/providers/presenter/product-ugc";
const timing = { source: "alignment" as const, words: [], scenes: [{ sceneId: "scene_1", startSeconds: 0.1, endSeconds: 1 }, { sceneId: "scene_2", startSeconds: 1.5, endSeconds: 2.5 }], speechEndSeconds: 2.5 };
describe("áudio para presenter", () => {
  it("recorta amostras reais localmente e mantém duração exata", async () => {
    const root = await mkdtemp(join(tmpdir(), "audio-slice-")); const path = join(root, "source.wav");
    await writeFile(path, wav(2, i => i < 16000 ? 1000 : 8000));
    const result = Buffer.from(await slicePresenterAudio(path, { startSeconds: 1.1, endSeconds: 1.6 }));
    expect(presenterWavDuration(result)).toBeCloseTo(0.5, 3);
    const data = result.indexOf(Buffer.from("data")) + 8;
    expect(result.readInt16LE(data + 1000)).toBe(8000);
  }, 35_000);
  it("usa início da fala seguinte como fronteira", () => {
    expect(alignedSceneWindows(simplePlan(), timing, 3)).toEqual([{ startSeconds: 0, endSeconds: 1.5 }, { startSeconds: 1.5, endSeconds: 3 }]);
    expect(alignedPresenterPlan(simplePlan(), timing, 3).scenes.map(s => s.duration)).toEqual([1.5, 1.5]);
  });
  it("recusa cena sem alignment, sobreposição ou WAV truncado", () => {
    expect(() => alignedSceneWindows(simplePlan(), { ...timing, scenes: [] }, 3)).toThrow();
    expect(() => alignedSceneWindows(simplePlan(), timing, 1)).toThrow();
    expect(() => presenterWavDuration(wav(1).subarray(0, 100))).toThrow();
  });
  it("Product UGC só prepara contrato com autorização e áudio desligado", () => {
    const input = { characterImage: { uri: "person.jpg" }, productImage: { uri: "product.jpg" }, imageConsent: true, productInfo: "Produto", userConcept: "Apresenta o produto sem depoimento ou prova inventada.", duration: 4 };
    expect(() => prepareProductUgc({ ...input, imageConsent: false })).toThrow();
    const prepared = prepareProductUgc(input);
    expect(prepared).toMatchObject({ endpoint: "/v1/recipes/product_ugc", body: { version: "2026-06", audio: false, characterImage: input.characterImage, productImage: input.productImage } });
    expect(prepared.body).not.toHaveProperty("imageConsent");
  });
});
