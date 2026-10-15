import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runwayFixture } from "./runway-fake";
import { makeMp4 } from "./mp4-fixture";
it("dry-run com foto real local não exige chave, não faz chamadas nem cria campanha", async () => {
  const fake = await runwayFixture();
  const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/video-real.ts", "--image", fake.image], {
    encoding: "utf8", env: { ...process.env, RUNWAYML_API_SECRET: "", LLM_PROVIDER: "mock", VIDEO_PROVIDER: "mock", AUDIO_PROVIDER: "mock", DATA_DIR: join(fake.root, "no-data"), VIDEOS_DIR: join(fake.root, "no-videos") }, timeout: 30_000,
  });
  expect(output).toContain("Dry-run");
  expect(output).toContain("25 créditos");
  expect(output).toContain("US$0.25");
  expect(output).not.toContain("Campanha ");
  expect(existsSync(join(fake.root, "no-data"))).toBe(false);
  expect(existsSync(join(fake.root, "no-videos"))).toBe(false);
});
describe("argumentos rejeitados antes de autorização", () => {
  it("flag desconhecida nunca é interpretada como confirmação", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/video-real.ts", "--confirmed"], { stdio: "pipe", timeout: 30_000 })).toThrow();
  });
});

it("--confirm com transporte totalmente falso executa uma geração via aprovação e ledger", async () => {
  const fake = await runwayFixture();
  const hook = join(fake.root, "fake-transport.mjs");
  const counter = join(fake.root, "posts.txt");
  await writeFile(hook, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.dev.runwayml.com/v1/image_to_video') {
        appendFileSync(process.env.VIDEO_TEST_COUNTER, 'POST\\n');
        return Response.json({ id: 'manual_task' });
      }
      if (url === 'https://api.dev.runwayml.com/v1/tasks/manual_task') return Response.json({ id: 'manual_task', status: 'SUCCEEDED', cost: { credits: 25 }, output: ['https://cdn.runwayml.com/manual.mp4'] });
      if (url === 'https://cdn.runwayml.com/manual.mp4') return new Response(Buffer.from('${Buffer.from(makeMp4(5)).toString("hex")}', 'hex'));
      throw new Error('Rede proibida: ' + url);
    };
  `);
  const dataDir = relative(process.cwd(), join(fake.root, "manual-data"));
  const videosDir = relative(process.cwd(), join(fake.root, "manual-videos"));
  const output = execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", "scripts/video-real.ts", "--image", fake.image, "--confirm"], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, RUNWAYML_API_SECRET: "fake-test-key", VIDEO_TEST_COUNTER: counter,
      DATA_DIR: dataDir, VIDEOS_DIR: videosDir, UPLOADS_DIR: relative(process.cwd(), join(fake.root, "manual-uploads")),
      LLM_PROVIDER: "mock", VIDEO_PROVIDER: "mock", AUDIO_PROVIDER: "mock", MAX_COST_PER_CREATIVE_BRL: "20", MAX_COST_PER_CAMPAIGN_BRL: "100" },
  });
  expect(output).toContain("Clipe salvo e custo registrado no ledger");
  expect(output).toContain("solicitado: 5.00s");
  expect(output).toContain("provider: indisponível");
  expect(output).toContain("arquivo real: 5.00s");
  expect((await readFile(counter, "utf8")).trim()).toBe("POST");
  const entries = (await readFile(join(dataDir, "ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const videoCosts = entries.filter((entry) => entry.category === "video");
  expect(videoCosts).toMatchObject([{ simulated: false, costUsd: 0.25 }]);
  expect(await readdir(join(dataDir, "jobs"))).toHaveLength(1);
});


it("CLI imprime diagnóstico sanitizado de rejeição com transporte offline", async () => {
  const fake = await runwayFixture();
  const hook = join(fake.root, "rejected-transport.mjs");
  await writeFile(hook, `globalThis.fetch = async () => Response.json({code:'quota_exceeded',message:'Insufficient credits fake-test-key'}, {status:429,headers:{'x-request-id':'req-cli'}});`);
  let stderr = "";
  try {
    execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", "scripts/video-real.ts", "--image", fake.image, "--confirm"], {
      encoding: "utf8", stdio: "pipe", timeout: 30_000,
      env: { ...process.env, RUNWAYML_API_SECRET: "fake-test-key", DATA_DIR: join(fake.root, "rejected-data"), UPLOADS_DIR: relative(process.cwd(), join(fake.root, "rejected-uploads")) },
    });
    throw new Error("CLI deveria falhar");
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? "");
  }
  expect(stderr).toContain("HTTP 429");
  expect(stderr).toContain("req-cli");
  expect(stderr).toContain("quota_exceeded");
  expect(stderr).not.toContain("fake-test-key");
  expect(stderr).not.toContain("Possível cobrança");
});
