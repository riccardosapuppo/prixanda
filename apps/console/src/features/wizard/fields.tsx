"use client";
// Form fields of the console: a visible label, a hint, and the error under
// the field, tied to it with aria-describedby, one message per case.
import type { ReactNode } from "react";
import { FieldError } from "../../components/ui.tsx";

type Common = {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode | undefined;
  readonly error?: string | null | undefined;
  readonly className?: string | undefined;
};

function describedBy(id: string, hint: ReactNode | undefined, error: string | null | undefined): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function FieldShell({ id, label, hint, error, className, children }: Common & { readonly children: ReactNode }) {
  return (
    <div className={["grid content-start gap-1.5", className ?? ""].join(" ")}>
      <label htmlFor={id} className="label">{label}</label>
      {hint ? <p id={`${id}-hint`} className="hint">{hint}</p> : null}
      {children}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </div>
  );
}

export function TextField({ id, label, hint, error, className, value, onChange, onBlur, disabled, type = "text", prefix, suffix, inputMode, autoComplete = "off", maxLength }: Common & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly disabled?: boolean;
  readonly type?: "text" | "datetime-local" | "number";
  readonly prefix?: string;
  readonly suffix?: string;
  readonly inputMode?: "decimal" | "numeric" | "text";
  readonly autoComplete?: string;
  readonly maxLength?: number;
}) {
  const described = describedBy(id, hint, error);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={className}>
      <span className="relative block">
        {prefix ? <b className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-semibold text-ink-2">{prefix}</b> : null}
        <input
          id={id}
          className={`input ${prefix ? "pl-7" : ""} ${suffix ? "pr-11" : ""}`}
          type={type}
          value={value}
          disabled={disabled}
          inputMode={inputMode}
          autoComplete={autoComplete}
          {...(maxLength ? { maxLength } : {})}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        {suffix ? <b className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-semibold text-ink-2">{suffix}</b> : null}
      </span>
    </FieldShell>
  );
}

export function TextAreaField({ id, label, hint, error, className, value, onChange, onBlur, disabled, rows = 4, maxLength }: Common & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly disabled?: boolean;
  readonly rows?: number;
  readonly maxLength?: number;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={className}>
      <textarea
        id={id}
        className="input"
        rows={rows}
        value={value}
        disabled={disabled}
        {...(maxLength ? { maxLength } : {})}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </FieldShell>
  );
}

export function SelectField({ id, label, hint, error, className, value, onChange, onBlur, disabled, options, placeholder }: Common & {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur?: () => void;
  readonly disabled?: boolean;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}) {
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} className={className}>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </FieldShell>
  );
}

/** A group of radio cards, with its legend, its hint and its error. */
export function ChoiceGroup<T extends string>({ id, legend, hint, error, value, onChange, onBlur, disabled, options }: {
  readonly id: string;
  readonly legend: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly value: T | "";
  readonly onChange: (value: T) => void;
  readonly onBlur?: () => void;
  readonly disabled?: boolean;
  readonly options: readonly { readonly value: T; readonly label: ReactNode; readonly detail?: ReactNode }[];
}) {
  const described = describedBy(id, hint, error);
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" aria-describedby={described} id={id} tabIndex={-1}>
      <legend className="label mb-1.5 p-0">{legend}</legend>
      {hint ? <p id={`${id}-hint`} className="hint -mt-1">{hint}</p> : null}
      {options.map((option) => (
        <label key={option.value} className="choice-card">
          <input
            type="radio"
            name={id}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={() => onChange(option.value)}
            onBlur={onBlur}
          />
          <span>
            {option.label}
            {option.detail ? <small className="block text-xs text-ink-2">{option.detail}</small> : null}
          </span>
        </label>
      ))}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </fieldset>
  );
}
