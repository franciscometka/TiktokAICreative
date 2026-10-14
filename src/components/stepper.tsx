import { cx } from "./ui/primitives";

export type StepState = "done" | "current" | "upcoming" | "error";

export interface StepItem {
  label: string;
  state: StepState;
  href?: string;
}

export const CREATION_STEPS = ["Produto", "Estratégia", "Planejamento", "Revisão", "Custo e aprovação"] as const;

/** Etapas do fluxo. No mobile mostra só a etapa atual por extenso. */
export function Stepper({ steps }: { steps: StepItem[] }) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.state === "current" || s.state === "error"),
  );
  const current = steps[currentIndex];
  return (
    <nav aria-label="Etapas da criação">
      <p className="mb-2 text-xs font-medium text-zinc-500 sm:hidden">
        Etapa {currentIndex + 1} de {steps.length} · <span className="text-zinc-900">{current?.label}</span>
      </p>
      <ol className="grid grid-cols-5 gap-1.5 sm:gap-3">
        {steps.map((step, i) => {
          const content = (
            <>
              <span
                className={cx(
                  "block h-1 rounded-full",
                  step.state === "done" && "bg-zinc-900",
                  step.state === "current" && "bg-zinc-900",
                  step.state === "error" && "bg-red-500",
                  step.state === "upcoming" && "bg-zinc-200",
                )}
              />
              <span
                className={cx(
                  "mt-2 hidden items-center gap-1.5 text-xs font-medium sm:flex",
                  step.state === "upcoming" ? "text-zinc-400" : "text-zinc-900",
                  step.state === "error" && "text-red-700",
                )}
              >
                <span className="tabular text-zinc-400">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate">{step.label}</span>
                {step.state === "done" && (
                  <svg viewBox="0 0 16 16" className="size-3.5 text-zinc-500" fill="none" aria-hidden>
                    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            </>
          );
          return (
            <li key={step.label} aria-current={step.state === "current" ? "step" : undefined} className="min-w-0">
              {step.href ? (
                <a href={step.href} className="block rounded outline-offset-4 focus-visible:outline-2">
                  {content}
                </a>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function stepsFor(states: StepState[], hrefs: (string | undefined)[] = []): StepItem[] {
  return CREATION_STEPS.map((label, i) => ({ label, state: states[i] ?? "upcoming", href: hrefs[i] }));
}
