"use client";
// The entrance: the visitor becomes one of the demo's invented listeners.
// DEMONSTRATION MODE, said in so many words: it is not a sign-in, nobody
// types anything, and each listener's label says what their simulated data
// shows. The gateway keeps the choice in an HttpOnly cookie of its own.
import { Icon } from "design/icon";
import { useEffect, useId, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import { useDemoListeners, useMarkets, useSignIn } from "../../data/hooks.ts";
import { Failure, Loading } from "../ui/States.tsx";

type Heading = "h1" | "h2" | "h3";

export function Entrance({ market, heading = "h2", focusOnMount = false }: {
  /** The market the visitor came for: its listeners come first. */
  readonly market?: string;
  readonly heading?: Heading;
  readonly focusOnMount?: boolean;
}) {
  const listeners = useDemoListeners();
  const markets = useMarkets();
  const signIn = useSignIn();
  const [picked, setPicked] = useState<string | null>(null);
  const titleId = useId();
  const head = useRef<HTMLHeadingElement>(null);
  const Heading = heading;

  useEffect(() => {
    if (focusOnMount) head.current?.focus();
  }, [focusOnMount]);

  const ordered = (listeners.data ?? []).toSorted((a, b) => Number(b.market === market) - Number(a.market === market));
  const chosen = picked ?? ordered[0]?.id ?? null;
  const marketName = (code: string) => markets.data?.find((each) => each.code === code)?.name ?? code;

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <Heading id={titleId} ref={head} tabIndex={-1} className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
        <Icon name="user-switch" size={20} />
        {copy.entrance.title}
      </Heading>
      <p className="m-0 max-w-[62ch] text-md text-ink-2">{copy.entrance.lede}</p>
      {listeners.isPending ? <Loading /> : null}
      {listeners.isError ? <Failure error={listeners.error} onRetry={() => void listeners.refetch()} /> : null}
      {listeners.isSuccess ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen !== null && !signIn.isPending) signIn.mutate(chosen);
          }}
        >
          <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
            <legend className="mb-2 p-0 font-[650]">{copy.entrance.legend}</legend>
            {ordered.map((listener) => (
              <label
                key={listener.id}
                className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 rounded-control border border-edge bg-stone-0 px-3 py-[0.7rem] has-[:checked]:border-ink has-[:checked]:shadow-[inset_0_0_0_1px_var(--color-ink)]"
              >
                <input
                  type="radio"
                  name="listener"
                  value={listener.id}
                  checked={chosen === listener.id}
                  onChange={() => setPicked(listener.id)}
                  className="mt-1 size-[1.05rem]"
                />
                <span className="grid gap-[0.15rem]">
                  <span className="font-semibold">{listener.title}</span>
                  <span className="text-sm text-ink-2">{listener.label}</span>
                  {market !== undefined && listener.market !== market ? (
                    <span className="text-sm text-ink-2">{copy.entrance.inOtherMarket(marketName(listener.market))}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          {signIn.isError ? <Failure error={signIn.error} /> : null}
          <p className="m-0">
            <button type="submit" className="btn btn-primary" aria-disabled={signIn.isPending || chosen === null}>
              <Icon name="door-open" size={18} />
              {copy.entrance.enter}
            </button>
          </p>
        </form>
      ) : null}
    </section>
  );
}
