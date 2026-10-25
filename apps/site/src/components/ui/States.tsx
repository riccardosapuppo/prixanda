"use client";
// What a page says while it waits for the API, and when the API does not
// answer: what happened, what the visitor can do, and the request's reference
// for anyone looking for it in the gateway's log.
import { Icon } from "design/icon";
import type { ReactNode } from "react";
import { copy, type ErrorCopyKey } from "../../content/copy.ts";
import { ApiError } from "../../data/api.ts";

export function Loading({ label = copy.states.loading, children }: { readonly label?: string; readonly children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="py-6 text-ink-2">
      <span className="inline-flex items-center gap-2">
        <Icon name="circle-notch" size={18} className="motion-safe:animate-spin" />
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Words that wait for a name the API gives, a market's or a plan's: until it
 * comes they keep their place, unseen and unread, so no code stands in for
 * the name and nothing moves when it arrives. `block` for a part of the page
 * rather than words in a line.
 */
export function Named({ ready, block = false, children }: { readonly ready: boolean; readonly block?: boolean; readonly children: ReactNode }) {
  if (ready) return <>{children}</>;
  const Tag = block ? "div" : "span";
  return <Tag className="invisible" aria-hidden="true">{children}</Tag>;
}

export function errorSentence(error: unknown): string {
  const code: ErrorCopyKey = error instanceof ApiError ? error.code : "INTERNAL";
  return copy.errors[code];
}

export function Failure({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) {
  const reference = error instanceof ApiError ? error.requestId : null;
  return (
    <div role="alert" className="grid max-w-[60ch] gap-3 border border-dashed border-ink-2 bg-stone-0 px-4 py-3">
      <p className="m-0 flex items-baseline gap-2">
        <Icon name="warning-circle" size={18} className="translate-y-[0.18em]" />
        <span>{errorSentence(error)}</span>
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {onRetry ? (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="arrows-clockwise" size={16} />
            {copy.states.retry}
          </button>
        ) : null}
        {reference ? <span className="text-sm text-ink-2">{copy.states.reference(reference)}</span> : null}
      </div>
    </div>
  );
}
