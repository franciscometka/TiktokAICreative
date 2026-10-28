import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalUgcAssetStore } from "./ugc-asset-store";

describe("LocalUgcAssetStore", () => {
  it("grava referências versionadas sem sobrescrever e resolve só por IDs válidos", async () => {
    const store = new LocalUgcAssetStore(await mkdtemp(join(tmpdir(), "ugc-store-")));
    const ids = { campaignId: "camp_1", creativeId: "cre_1" };
    const v1 = await store.saveReference({ ...ids, data: new Uint8Array([1, 2]), mimeType: "image/png", metadata: { referenceId: "r1" } });
    const v2 = await store.saveReference({ ...ids, data: new Uint8Array([3]), mimeType: "image/jpeg", metadata: { referenceId: "r2" } });
    expect([v1.version, v2.version]).toEqual(["v1", "v2"]);
    const r1 = await store.resolveReference({ ...ids, version: "v1" });
    expect(r1).toMatchObject({ mimeType: "image/png", sizeBytes: 2 });
    expect([...(await readFile(r1!.absolutePath))]).toEqual([1, 2]);
    expect((await store.resolveReference({ ...ids, version: "v2" }))?.mimeType).toBe("image/jpeg");
    expect(await store.resolveReference({ ...ids, version: "v9" })).toBeUndefined();
    expect(await store.resolveReference({ campaignId: "../x", creativeId: "cre_1", version: "v1" })).toBeUndefined();
  });
});
