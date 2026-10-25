"use client";
// Prepaid passes in the account (§9): the codes this listener bought, each
// with its state, and the way to activate a code, bought or given. A code is
// like money: the account is the session's own, so a code shows only to the
// listener who bought it, and the page writes it nowhere but on the screen.
// An activated code gives its months of a plan from today, never charged and
// never renewed, then Free; the facts above then say until when.
import { formatSitePrice, type MoneyLike } from "design";
import { Icon } from "design/icon";
import { useId, useRef, useState } from "react";
import { copy } from "../../content/copy.ts";
import { ApiError } from "../../data/api.ts";
import { type Me, useActivatePrepaidPass, usePlans } from "../../data/hooks.ts";
import { ActionKeys } from "../../data/ids.ts";
import { DEFAULT_MARKET, isSiteMarket } from "../../data/markets.ts";
import type { SitePrepaidCodeFragment } from "../../graphql/generated.ts";
import { normalCode } from "../../lib/codes.ts";
import { siteDay, siteDayAt } from "../../lib/dates.ts";
import { Refusal } from "../campaign/Checkout.tsx";
import { Failure } from "../ui/States.tsx";

type Code = SitePrepaidCodeFragment;

export function PrepaidCodes({ codes, write, timeZone }: {
  readonly codes: readonly Code[];
  readonly write: (money: MoneyLike, market: string) => string;
  readonly timeZone: string;
}) {
  const words = copy.account.codes;
  return (
    <section aria-labelledby="codes-title" className="grid max-w-[44rem] gap-3">
      <h2 id="codes-title" className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
        <Icon name="gift" size={22} />
        {words.title}
      </h2>
      <p className="m-0 text-md text-ink-2">{words.lede}</p>
      <ul role="list" className="codes">
        {codes.map((code) => (
          <li key={code.code} className="code-item" data-code-state={code.state}>
            <span className="code-words">
              <b>{code.title}</b>
              <span className="code num">{code.code}</span>
              <small>{words.bought(siteDayAt(code.boughtAt, timeZone), write(code.price, code.market))}</small>
            </span>
            <span className="code-state">
              <span className={code.state === "READY" ? "state state-first" : code.state === "ACTIVATED" ? "state state-done" : "state"}>
                {code.state === "ACTIVATED" ? <Icon name="check" size={13} /> : null}
                {words.state[code.state] ?? code.state}
              </span>
              <small>
                {code.state === "ACTIVATED" && code.activatedOn ? words.activatedOn(siteDay(code.activatedOn)) : null}
                {code.state === "EXPIRED" ? words.expiredOn(siteDay(code.validUntil)) : null}
                {code.state === "READY" || code.state === "PENDING" ? words.activateBy(siteDay(code.validUntil)) : null}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A code typed in, checked for its shape here and for everything else by the engine. */
export function ActivateCode({ me }: { readonly me: Me }) {
  const words = copy.account.activate;
  const activate = useActivatePrepaidPass();
  const [typed, setTyped] = useState("");
  const [shape, setShape] = useState(false);
  // One key per code, sent again only to retry an attempt that ended in an error; an answer, the
  // subscription or a refusal, spends it, so a code refused while its payment was pending is sent
  // afresh once it settled, and not answered with that refusal again.
  const keys = useRef(new ActionKeys<string>());
  const field = useId();
  const answer = activate.data?.activatePrepaidPass;
  // A code the engine does not know, typed wrong most likely, is said so, not as a failure of the service.
  const unknown = activate.isError && activate.error instanceof ApiError && activate.error.code === "NOT_FOUND";
  const send = (code: string) => {
    activate.mutate({ code, idempotencyKey: keys.current.key(code) }, {
      onSuccess: (data) => {
        keys.current.answered(code);
        // An activated code leaves the field: it has done its work.
        if (data.activatePrepaidPass.__typename === "Subscription") setTyped("");
      },
    });
  };
  const plans = usePlans(isSiteMarket(me.market) ? me.market : DEFAULT_MARKET);
  const planName = (code: string) => plans.data?.find((plan) => plan.code === code)?.name ?? code;

  return (
    <section aria-labelledby="activate-title" className="grid max-w-[44rem] gap-3">
      <h2 id="activate-title" className="m-0 flex items-center gap-2 text-3xl font-[650] [font-stretch:112%]">
        <Icon name="seal-check" size={22} />
        {words.title}
      </h2>
      <p className="m-0 text-md text-ink-2">{words.lede}</p>
      <form
        className="activate"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (activate.isPending) return;
          const code = normalCode(typed);
          setShape(code === null);
          if (code !== null) send(code);
        }}
      >
        <label htmlFor={field} className="font-[650]">{words.label}</label>
        <input
          id={field}
          name="prepaid-code"
          className="code-field"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={24}
          aria-describedby={`${field}-hint`}
          aria-invalid={shape}
        />
        <p id={`${field}-hint`} className="m-0 text-md text-ink-2">{shape ? words.shape : words.hint}</p>
        <p className="m-0">
          <button type="submit" className="btn btn-primary" aria-disabled={activate.isPending}>
            {activate.isPending ? words.activating : words.action}
          </button>
        </p>
      </form>
      {answer?.__typename === "Subscription" && answer.endsOn ? (
        <p role="status" className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 border border-ink bg-stone-0 px-3 py-2">
          <Icon name="check-circle" size={18} className="mt-[0.2rem]" />
          <span>{words.done(planName(answer.plan), siteDay(answer.endsOn))}</span>
        </p>
      ) : null}
      {answer?.__typename === "Refusal" ? <Refusal title={words.refused} reason={answer.reason} /> : null}
      {unknown ? <Refusal title={words.refused} reason={words.unknown} /> : null}
      {activate.isError && !unknown ? <Failure error={activate.error} /> : null}
    </section>
  );
}

/** Money of a code, written the way its market writes it. */
export function codeMoney(money: MoneyLike, market: string): string {
  return isSiteMarket(market) ? formatSitePrice(money, market) : `${money.amountMinor} ${money.currency}`;
}
