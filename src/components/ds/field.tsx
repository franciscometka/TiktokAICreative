"use client";

import { ChevronDown } from "lucide-react";
import { createContext, useContext, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { inputClass } from "./input-class";
import { cx } from "./styles";

/**
 * Campos: Field (label + dica + erro, liga ids/aria sozinho), Input, Textarea e Select nativo.
 * Dentro de um Field, os controles herdam id, `aria-invalid` e `aria-describedby`.
 */

interface FieldContext { id: string; describedBy: string | undefined; invalid: boolean }
const FieldCtx = createContext<FieldContext | null>(null);

export function Field({ label, hint, error, id: idProp, className, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; id?: string; className?: string; children: ReactNode }) {
  const auto = useId();
  const id = idProp ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldCtx.Provider value={{ id, describedBy: [hintId, errorId].filter(Boolean).join(" ") || undefined, invalid: !!error }}>
      <div className={className}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
          {hint ? <span id={hintId} className="text-caption text-fg-subtle">{hint}</span> : null}
        </div>
        {children}
        <FieldMessage id={errorId}>{error}</FieldMessage>
      </div>
    </FieldCtx.Provider>
  );
}

export function FieldMessage({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? <p id={id} role="alert" className="mt-1.5 animate-fade-in text-caption font-medium text-danger">{children}</p> : null;
}

function useFieldProps(id: string | undefined, invalid: boolean | undefined, describedBy: string | undefined) {
  const ctx = useContext(FieldCtx);
  const isInvalid = invalid ?? ctx?.invalid ?? false;
  return { id: id ?? ctx?.id, "aria-invalid": isInvalid || undefined, "aria-describedby": describedBy ?? ctx?.describedBy, isInvalid };
}

type Common = { invalid?: boolean; inputSize?: "md" | "lg" };

export function Input({ invalid, inputSize, className, id, "aria-describedby": describedBy, ...rest }: InputHTMLAttributes<HTMLInputElement> & Common) {
  const { isInvalid, ...a11y } = useFieldProps(id, invalid, describedBy);
  return <input className={cx(inputClass({ invalid: isInvalid, size: inputSize }), className)} {...a11y} {...rest} />;
}

export function Textarea({ invalid, inputSize = "lg", className, id, "aria-describedby": describedBy, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & Common) {
  const { isInvalid, ...a11y } = useFieldProps(id, invalid, describedBy);
  return <textarea className={cx(inputClass({ invalid: isInvalid, size: inputSize }), "resize-none leading-relaxed", className)} {...a11y} {...rest} />;
}

export function Select({ invalid, inputSize, className, id, children, "aria-describedby": describedBy, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & Common) {
  const { isInvalid, ...a11y } = useFieldProps(id, invalid, describedBy);
  return (
    <div className={cx("relative", className)}>
      <select className={cx(inputClass({ invalid: isInvalid, size: inputSize }), "appearance-none pr-10 [&>option]:bg-elevated [&>option]:text-fg")} {...a11y} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </div>
  );
}
