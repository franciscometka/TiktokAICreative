import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runwayFixture } from "./runway-fake";
it("dry-run com foto real local não exige chave, não faz chamadas nem cria campanha", async () => {
  const fake = await runwayFixture();
  const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/video-real.ts", "--image", fake.image], {
    encoding: "utf8", env: { ...process.env, RUNWAYML_API_SECRET: "", LLM_PROVIDER: "mock", VIDEO_PROVIDER: "mock", AUDIO_PROVIDER: "mock", DATA_DIR: join(fake.root, "no-data"), VIDEOS_DIR: join(fake.root, "no-videos") }, timeout: 30_000,
  });
  expect(output).toContain("Dry-run");
  expect(output).toContain("960:960");
  expect(output).toContain("slides slowly sideways");
  expect(output).not.toContain("push in");
  expect(output).toContain("25 créditos");
  expect(output).toContain("US$0.25");
  expect(output).not.toContain("Campanha ");
  expect(existsSync(join(fake.root, "no-data"))).toBe(false);
  expect(existsSync(join(fake.root, "no-videos"))).toBe(false);
}, 35_000);
describe("argumentos rejeitados antes de autorização", () => {
  it("flag desconhecida nunca é interpretada como confirmação", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/video-real.ts", "--confirmed"], { stdio: "pipe", timeout: 30_000 })).toThrow();
  });
});

it.each(["video", "tts", "plan", "presenter"])("%s: --confirm permanece bloqueado mesmo com chaves e ambiente", async script => {
  const fake = await runwayFixture();
  const forbidden = join(fake.root, "forbidden.mjs");
  const counter = join(fake.root, "network.txt");
  await writeFile(forbidden, `import { writeFileSync } from 'node:fs'; globalThis.fetch = async () => { writeFileSync(process.env.NETWORK_COUNTER, 'called'); throw new Error('unexpected network'); };`);
  let errorText = "";
  try {
    execFileSync(process.execPath, ["--import", pathToFileURL(forbidden).href, "--import", "tsx", `scripts/${script}-real.ts`, "--confirm"], {
      encoding: "utf8", stdio: "pipe", timeout: 30000, env: { ...process.env, NETWORK_COUNTER: counter, RUNWAYML_API_SECRET: "fake-key", ELEVENLABS_API_KEY: "fake-key", ANTHROPIC_API_KEY: "fake-key", REAL_CALLS_ENABLED: "true", DATA_DIR: join(fake.root, "blocked-data") },
    });
  } catch (error) { errorText = String((error as { stderr?: string }).stderr ?? ""); }
  expect(errorText).toContain("reais/pagas bloqueadas");
  expect(errorText).not.toContain("fake-key");
  expect(existsSync(counter)).toBe(false);
  expect(existsSync(join(fake.root, "blocked-data"))).toBe(false);
}, 35000);

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
  expect(stderr).toContain("reais/pagas bloqueadas");
  expect(stderr).not.toContain("req-cli");
  expect(stderr).not.toContain("quota_exceeded");
  expect(stderr).not.toContain("fake-test-key");
  expect(stderr).not.toContain("Possível cobrança");
});
