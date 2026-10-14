import { rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { VERSION as REMOTION_VERSION } from "remotion";
import { RenderManifestSchema, type RenderManifest } from "@/domain/render";
import { COMPOSITION_ID, COMPOSITION_VERSION } from "../../../remotion/types/props";
import { AssetResolver, type ResolvedAsset } from "../asset-resolver";
import { buildCompositionProps } from "../composition-props";
import {
  allocateRenderDir,
  FINAL_FILE,
  MANIFEST_FILE,
  PARTIAL_FILE,
  relativeRenderUri,
} from "../output-paths";
import type { Renderer, RenderOptions, RenderResult } from "../renderer";
import { startAssetServer, type AssetServer } from "./asset-server";

/**
 * ÚNICO lugar que importa @remotion/bundler e @remotion/renderer.
 * Fluxo: valida manifest → resolve assets autorizados → servidor local de assets → props →
 * bundle (cacheado no processo) → selectComposition → renderMedia (H.264, yuv420p, sem áudio)
 * → final.mp4 + manifest.json numa pasta de versão nova. Nenhuma regra de negócio aqui.
 */

export const RENDERER_VERSION = "remotion-renderer@1.0.0";

export interface RemotionRendererOptions {
  rendersDir: string;
  /** Pastas de onde imagens podem ser lidas (ex.: UPLOADS_DIR). */
  allowedAssetRoots: readonly string[];
  /** Entrada do bundle Remotion. Padrão: remotion/index.ts na raiz do projeto. */
  entryPoint?: string;
  projectRoot?: string;
  /** null = Remotion decide. */
  concurrency?: number | null;
  /** Qualidade H.264 (menor = melhor/maior). 20 equilibra tamanho e qualidade para social. */
  crf?: number;
  /** Chave de licença Remotion (Company License). Ausente = nenhuma chamada de telemetria. */
  licenseKey?: string | null;
  /** Mostra descrições técnicas nos placeholders. */
  debug?: boolean;
  /** Chrome alternativo. Padrão: o Chrome Headless Shell baixado pelo Remotion em node_modules/.remotion. */
  browserExecutable?: string | null;
}

export class RemotionRenderer implements Renderer {
  readonly id = "remotion";
  readonly isMock = false;
  private bundlePromise: Promise<string> | undefined;
  private readonly resolver: AssetResolver;
  private readonly projectRoot: string;

  constructor(private readonly options: RemotionRendererOptions) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.resolver = new AssetResolver(options.allowedAssetRoots, this.projectRoot);
  }

  /** Bundle webpack uma vez por processo (cache técnico em memória). Falha → próxima chamada tenta de novo. */
  private getBundle(): Promise<string> {
    this.bundlePromise ??= (async () => {
      await ensureBrowser({ logLevel: "error", browserExecutable: this.options.browserExecutable ?? null });
      return bundle({
        entryPoint: this.options.entryPoint ?? resolve(this.projectRoot, "remotion", "index.ts"),
        rootDir: this.projectRoot,
        enableCaching: true,
        onProgress: () => {},
      });
    })().catch((error: unknown) => {
      this.bundlePromise = undefined;
      throw error;
    });
    return this.bundlePromise;
  }

  async render(input: RenderManifest, options: RenderOptions = {}): Promise<RenderResult> {
    const started = Date.now();
    const manifest = RenderManifestSchema.parse(input);
    const campaignId = manifest.campaignId;
    if (!campaignId) throw new Error("Manifest sem campaignId: gere o manifest de novo (buildRenderManifest)");

    // 1. Assets: erro de segurança/corrupção interrompe o render; ausência vira warning.
    const resolved = new Map<string, ResolvedAsset>();
    for (const asset of manifest.assets) {
      if (asset.uri && !resolved.has(asset.uri)) resolved.set(asset.uri, await this.resolver.resolve(asset.uri));
    }
    const files = new Map(
      [...resolved].flatMap(([uri, r]) => (r.kind === "file" ? [[uri, { absolutePath: r.absolutePath, contentType: r.contentType }] as const] : [])),
    );

    const { renderId, dir } = await allocateRenderDir(this.options.rendersDir, campaignId, manifest.creativeId, options.preferredVersion);
    const partial = join(dir, PARTIAL_FILE);
    let server: AssetServer | undefined;
    try {
      server = await startAssetServer(files);
      const assetServer = server;
      const { props, warnings } = buildCompositionProps({
        manifest,
        assets: resolved,
        urlFor: (uri) => assetServer.urlFor(uri),
        debug: this.options.debug ?? false,
      });
      const serveUrl = await this.getBundle();
      const licenseKey = this.options.licenseKey ?? null;
      const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props, logLevel: "error", browserExecutable: this.options.browserExecutable ?? null });

      await renderMedia({
        composition,
        serveUrl,
        inputProps: props,
        codec: "h264",
        pixelFormat: "yuv420p",
        // bt709 + range limitado: yuv420p "tv" (o padrão do Remotion sai yuvj420p full-range).
        colorSpace: "bt709",
        crf: this.options.crf ?? 20,
        muted: true,
        outputLocation: partial,
        overwrite: false,
        concurrency: this.options.concurrency ?? null,
        logLevel: "error",
        licenseKey,
        browserExecutable: this.options.browserExecutable ?? null,
        onProgress: ({ renderedFrames }) =>
          options.onProgress?.({ renderedFrames, totalFrames: composition.durationInFrames }),
      });
      await rename(partial, join(dir, FINAL_FILE));
      const { size } = await stat(join(dir, FINAL_FILE));
      const renderMs = Date.now() - started;

      // Registro reprodutível: sem caminhos absolutos, sem URLs efêmeras, sem segredos.
      const urlToUri = new Map([...files.keys()].map((uri) => [assetServer.urlFor(uri), uri]));
      const record = {
        rendererVersion: RENDERER_VERSION,
        compositionId: COMPOSITION_ID,
        compositionVersion: COMPOSITION_VERSION,
        remotionVersion: REMOTION_VERSION,
        renderId,
        renderedAt: new Date().toISOString(),
        renderMs,
        output: { file: FINAL_FILE, codec: "h264", pixelFormat: "yuv420p", colorSpace: "bt709", audio: false, sizeBytes: size },
        fps: props.fps,
        width: props.width,
        height: props.height,
        durationInFrames: props.durationInFrames,
        manifest,
        props,
        warnings,
      };
      await writeFile(
        join(dir, MANIFEST_FILE),
        JSON.stringify(record, (_key, value: unknown) => (typeof value === "string" && urlToUri.has(value) ? `asset:${urlToUri.get(value)}` : value), 2),
      );

      return {
        outputUri: relativeRenderUri(this.options.rendersDir, campaignId, manifest.creativeId, renderId, FINAL_FILE),
        manifestUri: relativeRenderUri(this.options.rendersDir, campaignId, manifest.creativeId, renderId, MANIFEST_FILE),
        isMock: false,
        usage: { generations: 1, seconds: manifest.duration },
        renderId,
        sizeBytes: size,
        durationSeconds: props.durationInFrames / props.fps,
        totalFrames: props.durationInFrames,
        renderMs,
        warnings,
      };
    } catch (error) {
      // Remove só o que ESTE render criou (arquivo parcial e a pasta vazia da versão).
      await rm(partial, { force: true });
      await rmdir(dir).catch(() => {});
      throw error;
    } finally {
      await server?.close();
    }
  }
}
