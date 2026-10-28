import { cx, interactive } from "./styles";

/** Classe de input/textarea/select (server-safe: usada por v2Input em telas server e client). */
export function inputClass({ invalid = false, size = "md" }: { invalid?: boolean; size?: "md" | "lg" } = {}): string {
  return cx(
    "block w-full rounded-[10px] border bg-surface-sunken text-fg placeholder:text-fg-subtle",
    interactive,
    "hover:border-line-strong focus:outline-none focus:border-primary-light/70 focus:bg-surface focus:ring-4 focus:ring-primary/15",
    "disabled:cursor-not-allowed disabled:opacity-50",
    invalid ? "border-danger/60 focus:border-danger focus:ring-danger/15" : "border-line",
    size === "md" ? "px-3.5 py-2.5 text-sm" : "px-4 py-3 text-body",
  );
}
