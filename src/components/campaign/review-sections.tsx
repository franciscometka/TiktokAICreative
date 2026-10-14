import type { CampaignView, CreativeView } from "@/application/campaign-view";
import { Badge, cx, Panel, SectionHeading } from "../ui/primitives";
import { CopyButton } from "./copy-button";

/** Seções de leitura do plano: análise, hooks e conceitos. Só apresentação. */

function BulletList({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-sm text-zinc-400">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm leading-relaxed text-zinc-700">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-zinc-400" aria-hidden />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function AnalysisBlock({ title, items, tone }: { title: string; items: string[]; tone?: "amber" }) {
  return (
    <div className="min-w-0">
      <h3 className={cx("text-xs font-semibold tracking-wider uppercase", tone === "amber" ? "text-amber-700" : "text-zinc-500")}>
        {title}
      </h3>
      <div className="mt-2">
        <BulletList items={items} />
      </div>
    </div>
  );
}

export function AnalysisSection({ analysis }: { analysis: NonNullable<CampaignView["analysis"]> }) {
  return (
    <section id="analise" className="scroll-mt-20 space-y-4">
      <SectionHeading eyebrow="Revisão" title="Análise do produto" />
      <Panel className="p-5 sm:p-6">
        <p className="max-w-3xl text-[15px] leading-relaxed text-zinc-800">{analysis.summary}</p>
        <div className="mt-6 grid gap-x-8 gap-y-6 border-t border-zinc-100 pt-6 md:grid-cols-2">
          <AnalysisBlock title="Público" items={analysis.targetAudiences} />
          <AnalysisBlock title="Problemas e desejos" items={analysis.problemsSolved} />
          <AnalysisBlock title="Benefícios" items={analysis.benefits} />
          <AnalysisBlock title="Diferenciais" items={analysis.differentiators} />
          <AnalysisBlock title="Objeções" items={analysis.objections} />
          <AnalysisBlock title="Ângulos de venda" items={analysis.sellingAngles} />
          <AnalysisBlock title="Riscos de comunicação" items={analysis.communicationRisks} tone="amber" />
          <AnalysisBlock title="Informações ausentes" items={analysis.missingInformation} tone="amber" />
        </div>
      </Panel>
    </section>
  );
}

export function HooksSection({ hooks }: { hooks: CampaignView["hooks"] }) {
  return (
    <section id="hooks" className="scroll-mt-20 space-y-4">
      <SectionHeading title="Hooks" description={`${hooks.length} ganchos para os primeiros segundos. Use os extras em testes A/B.`} />
      <Panel>
        <ol className="divide-y divide-zinc-100">
          {hooks.map((hook, i) => (
            <li key={hook.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
              <span className="mt-0.5 w-6 shrink-0 text-xs font-medium text-zinc-400 tabular">{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-zinc-900">“{hook.text}”</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                  <Badge>{hook.styleLabel}</Badge>
                  <span>{hook.angle}</span>
                </p>
              </div>
              <CopyButton text={hook.text} label={`Copiar hook ${i + 1}`} />
            </li>
          ))}
        </ol>
      </Panel>
    </section>
  );
}

export function ConceptsSection({ creatives }: { creatives: CreativeView[] }) {
  return (
    <section id="conceitos" className="scroll-mt-20 space-y-4">
      <SectionHeading title="Conceitos" description="Um conceito por criativo, cada um com ângulo e emoção próprios." />
      <div className="grid gap-3 md:grid-cols-2">
        {creatives.map((c) => (
          <Panel key={c.id} className="flex flex-col p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <a href={`#criativo-${c.number}`} className="text-xs font-semibold tracking-wider text-zinc-500 uppercase hover:text-zinc-900">
                Criativo {String(c.number).padStart(2, "0")} ↓
              </a>
              <Badge>{c.concept.formatLabel}</Badge>
            </div>
            <h3 className="mt-2 font-semibold text-zinc-900">{c.concept.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">{c.concept.description}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-zinc-500">Ângulo</dt>
                <dd className="mt-0.5 text-zinc-800">{c.concept.angle}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-zinc-500">Emoção</dt>
                <dd className="mt-0.5 text-zinc-800">{c.concept.emotion}</dd>
              </div>
              <div className="col-span-2 min-w-0">
                <dt className="text-xs text-zinc-500">Hook principal</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">“{c.concept.hook}”</dd>
              </div>
            </dl>
          </Panel>
        ))}
      </div>
    </section>
  );
}
