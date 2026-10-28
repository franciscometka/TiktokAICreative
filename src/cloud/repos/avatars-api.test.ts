import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudHarness, FAKE_SECRETS, type CloudHarness } from "@/test/cloud-harness";

/** L8.7 — GET /v1/avatars/:id/detail: perfil só leitura (revisões + uso), isolado por usuário. */

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

describe("GET /v1/avatars/:id/detail", () => {
  it("revisões e uso do PRÓPRIO usuário; outro usuário não vê; nada técnico no corpo", async () => {
    const created = await h.call("POST", "/v1/avatars", { body: { name: "Cristina", gender: "woman", tags: ["beleza"], defaultForTags: ["cabelo"], voiceProfileId: "voice_clara" } });
    expect(created.json.ok).toBe(true);
    const id = created.json.value.id as string;
    await h.call("POST", "/v1/avatars", { body: { id, name: "Cristina", gender: "woman", hair: "castanho", tags: ["beleza"], defaultForTags: ["cabelo"], voiceProfileId: "voice_clara" } });
    const detail = await h.call("GET", `/v1/avatars/${id}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.json.value.revisions.map((r: { revision: number; current: boolean }) => [r.revision, r.current])).toEqual([[2, true], [1, false]]);
    expect(detail.json.value.usage).toEqual({ count: 0, recent: [] });
    expect(detail.text).not.toMatch(/providerVoiceId|"uri"/);
    for (const secret of Object.values(FAKE_SECRETS)) expect(detail.text).not.toContain(secret);
    expect((await h.call("GET", `/v1/avatars/${id}/detail`, { user: "b" })).status).toBe(404);
    expect((await h.call("GET", "/v1/avatars/../detail")).status).toBe(404);
  });
});
