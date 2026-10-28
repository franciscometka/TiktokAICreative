import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { focusRing } from "./styles";

/** L8.9 — Tailwind v4: `outline-none` zera `--tw-outline-style`; sem `outline-solid` o anel de foco fica invisível. */
describe("anel de foco visível", () => {
  it("focusRing define o estilo da outline no foco por teclado", () => {
    expect(focusRing).toContain("outline-none");
    expect(focusRing).toContain("focus-visible:outline-solid");
  });

  it("indicador do worker (classe própria) também", () => {
    const source = readFileSync(join(__dirname, "../shell/worker-status.tsx"), "utf8");
    expect(source).toContain("focus-visible:outline-solid");
  });
});
