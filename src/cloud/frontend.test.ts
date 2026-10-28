import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LocalOnly, ServiceUnavailable } from "@/components/v2/service-unavailable";
import { apiFetch, ServiceUnavailableError, UNAVAILABLE_RESULT } from "@/server/backend";
import { runtimeMode, safeNext } from "@/server/session";
import { loadFrontendEnv, SERVER_SECRET_VARIABLES } from "./config";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function resolveImport(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : undefined;
  if (!base) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

/** Tudo que um componente "use client" puxa para o bundle do browser (para em "use server"). */
function clientClosure(): Set<string> {
  const roots = walk(SRC).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/^\s*["']use server["']/.test(text)) continue; // Server Action: o browser só recebe a referência
    seen.add(file);
    for (const m of text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
      const target = resolveImport(file, m[1]!);
      if (target) queue.push(target);
    }
  }
  return seen;
}

describe("segredos nunca chegam ao client (bundle do browser)", () => {
  const closure = clientClosure();

  it("nenhum módulo do client lê variável de ambiente que não seja NEXT_PUBLIC_*", () => {
    expect(closure.size).toBeGreaterThan(5);
    for (const file of closure) {
      const reads = [...readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]!);
      expect({ file, bad: reads.filter((name) => !name.startsWith("NEXT_PUBLIC_") && name !== "NODE_ENV") }).toEqual({ file, bad: [] });
    }
  });

  it("nenhum módulo do client conhece service role, DATABASE_URL ou chaves de provider", () => {
    for (const file of closure) {
      const text = readFileSync(file, "utf8");
      // Citar o NOME numa mensagem de ajuda é ok; LER o valor (env/leitor de chave) não.
      for (const name of SERVER_SECRET_VARIABLES) expect({ file, reads: new RegExp(`(process\\.env\\.|env\\[["'])${name}`).test(text) }).toEqual({ file, reads: false });
      expect({ file, keyReader: /read(Anthropic|Krea|ElevenLabs|Runway|GoogleAi)ApiKey|readRemotionLicenseKey|serviceRoleKey/.test(text) }).toEqual({ file, keyReader: false });
      expect({ file, imports: /from ["']@\/(cloud\/(db|repos|infra|runtime|assets|queue|worker|api)|config\/env|server\/(runtime|backend|session))/.test(text) }).toEqual({ file, imports: false });
    }
  });

  it("env do frontend só expõe as três variáveis públicas", () => {
    const env = loadFrontendEnv({ NEXT_PUBLIC_RUNTIME_MODE: "cloud", NEXT_PUBLIC_API_BASE_URL: "https://api.example.com", NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-key-0123456789", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-0123456789", KREA_API_KEY: "krea-secret-0123456789" });
    expect(Object.keys(env).sort()).toEqual(["apiBaseUrl", "mode", "supabaseAnonKey", "supabaseUrl"]);
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });
});

describe("backend indisponível", () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE_URL;
  afterEach(() => { if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL; else process.env.NEXT_PUBLIC_API_BASE_URL = previous; });

  it("conexão recusada vira 'Serviço temporariamente indisponível.' (sem ECONNREFUSED/URL interna)", async () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:9";
    await expect(apiFetch("token", "GET", "/v1/projects")).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(UNAVAILABLE_RESULT.error.title).toBe("Serviço temporariamente indisponível.");
    const html = renderToStaticMarkup(createElement(ServiceUnavailable));
    expect(html).toContain("Serviço temporariamente indisponível.");
    expect(html).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|onrender|stack|SELECT/i);
    expect(renderToStaticMarkup(createElement(LocalOnly))).toContain("modo local");
  });
});

describe("sessão", () => {
  it("modo local continua o padrão; redirect pós-login só para caminho interno", () => {
    expect(runtimeMode()).toBe("local");
    expect(safeNext("/projects?filter=ready")).toBe("/projects?filter=ready");
    for (const bad of ["https://evil.com", "//evil.com", "javascript:alert(1)", undefined, ""]) expect(safeNext(bad)).toBe("/");
  });
});
