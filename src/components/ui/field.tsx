import type { ReactNode } from "react";
import { cx } from "./primitives";

export const inputClasses = (invalid?: boolean) =>
  cx(
    "block w-full rounded-md border bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400",
    "focus:outline-none focus:ring-2 focus:ring-zinc-900/10",
    invalid ? "border-red-400 focus:border-red-500" : "border-zinc-300 focus:border-zinc-500",
  );

export function Field({
  id,
  label,
  required,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-zinc-900">
          {label}
          {required ? <span className="text-red-600"> *</span> : <span className="ml-1.5 text-xs font-normal text-zinc-400">opcional</span>}
        </label>
      </div>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1.5 text-xs text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
