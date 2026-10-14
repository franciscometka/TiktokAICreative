import { continueRender, delayRender } from "remotion";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import inter800 from "@fontsource/inter/files/inter-latin-800-normal.woff2";
import inter900 from "@fontsource/inter/files/inter-latin-900-normal.woff2";

/**
 * Inter (SIL Open Font License) empacotada pelo bundler a partir de @fontsource/inter:
 * nenhuma chamada externa durante o render. O subset "latin" cobre acentos do português.
 */
const FILES: [string, number][] = [
  [inter400, 400],
  [inter600, 600],
  [inter700, 700],
  [inter800, 800],
  [inter900, 900],
];

let loading: Promise<void> | null = null;

export function loadFonts(): void {
  if (loading || typeof document === "undefined") return;
  const handle = delayRender("Carregando fonte Inter");
  loading = Promise.all(
    FILES.map(async ([url, weight]) => {
      const face = new FontFace("Inter", `url(${url}) format("woff2")`, { weight: String(weight), style: "normal" });
      document.fonts.add(await face.load());
    }),
  ).then(() => continueRender(handle));
}
