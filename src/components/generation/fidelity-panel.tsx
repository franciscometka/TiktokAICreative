"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ProjectV2View } from "@/application/project-v2-view";
import { Badge, Button, Card, cx, focusRing } from "../ds";

/**
 * L8.5 — Product Fidelity (conferência da referência). Redesenho visual da MESMA lógica do
 * Lote 6: comparação (foto do avatar · referência · foto do produto), checklist completo (inclui
 * cada especificação exata), "Confirmar"/"Usar esta pessoa" só com TUDO marcado, "Gerar outra"
 * quando permitido. Status e divergências do gate aparecem quando existem. Nada é escondido.
 */

type Approval = NonNullable<ProjectV2View["approval"]>;

function Figure({ src, alt, caption, tall }: { src: string | null; alt: string; caption: string; tall?: boolean }) {
  return (
    <figure className="min-w-0">
      <div className={cx("overflow-hidden rounded-xl bg-surface-sunken ring-1 ring-line", tall ? "aspect-[9/16]" : "aspect-square")}>
        {src
          // eslint-disable-next-line @next/next/no-img-element -- imagem servida por rota com IDs
          ? <img src={src} alt={alt} className="size-full animate-reveal object-cover" />
          : <div className="grid size-full place-items-center text-caption text-fg-subtle">Imagem indisponível</div>}
      </div>
      <figcaption className="mt-1.5 text-caption text-fg-subtle">{caption}</figcaption>
    </figure>
  );
}

export function FidelityPanel({ approval, productImageUrl, gate, jobId, pending, onApprove, onRegenerate }: {
  approval: Approval;
  productImageUrl: string | null;
  gate: { statusLabel: string; conflicts: string[] } | null;
  jobId: string | null;
  pending: boolean;
  onApprove: (jobId: string, referenceId: string, specs: string[]) => void;
  onRegenerate: (jobId: string) => void;
}) {
  const [checks, setChecks] = useState<boolean[]>([]);
  const allChecked = approval.checklist.every((_, i) => checks[i]);
  return (
    <Card padding="none" className="p-5 sm:p-6" id="approval" data-fidelity>
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-5 text-primary-light" aria-hidden />
        <h2 className="text-heading font-semibold text-fg">{approval.title}</h2>
        {gate ? <Badge tone={gate.conflicts.length ? "warning" : "neutral"}>{gate.statusLabel}</Badge> : null}
      </div>
      {approval.simulated ? <p className="mt-1 text-caption text-warning">Simulação: a imagem é a foto do produto.</p> : null}

      <div className={cx("mt-5 grid gap-3", approval.avatarPhotoUrl ? "grid-cols-3" : "grid-cols-2")}>
        {approval.avatarPhotoUrl ? <Figure src={approval.avatarPhotoUrl} alt={`Foto do avatar ${approval.avatarName ?? ""}`.trim()} caption={`Foto de ${approval.avatarName ?? "seu avatar"}`} /> : null}
        <Figure src={approval.imageUrl} alt={approval.avatarName ? `${approval.avatarName} com o produto` : "Apresentadora com o produto"} caption="Referência gerada" tall />
        <Figure src={productImageUrl} alt="Foto original do produto" caption="Seu produto" />
      </div>
      {approval.avatarPhotoUrl ? <p className="mt-2 text-caption text-fg-subtle">A pessoa da referência deve ser a mesma da foto do avatar.</p> : null}

      {gate?.conflicts.length ? (
        <ul className="mt-4 space-y-1 rounded-xl bg-warning-soft p-3 text-sm text-warning ring-1 ring-inset ring-warning/25" aria-label="Divergências encontradas">
          {gate.conflicts.map((c) => <li key={c}>• {c}</li>)}
        </ul>
      ) : null}

      <fieldset className="mt-5">
        <legend className="text-sm font-medium text-fg">Confira cada item</legend>
        <ul className="mt-3 space-y-2.5">
          {approval.checklist.map((item, i) => (
            <li key={item}>
              <label className={cx("flex cursor-pointer items-start gap-3 rounded-lg p-1 text-sm text-fg", focusRing)}>
                <input type="checkbox" className="mt-0.5 size-[18px] shrink-0 rounded accent-violet-600" checked={!!checks[i]}
                  onChange={(e) => setChecks((c) => { const n = [...c]; n[i] = e.target.checked; return n; })} />
                {item}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        <Button size="lg" loading={pending} disabled={!allChecked || !jobId} onClick={() => onApprove(jobId!, approval.referenceId, approval.specs)}>
          {approval.kind === "presenter" ? "Usar esta pessoa" : "Confirmar"}
        </Button>
        {approval.canGenerateOther ? <Button size="lg" variant="secondary" disabled={pending || !jobId} onClick={() => onRegenerate(jobId!)}>Gerar outra</Button> : null}
      </div>
      {!allChecked ? <p className="mt-2 text-caption text-fg-subtle">O botão libera quando todos os itens estiverem marcados.</p> : null}
    </Card>
  );
}
