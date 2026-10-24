// The promise to the artists, told once on a campaign page (business book
// §1.2, §5.3): of the offer price, what the artists' pool gets, and, when that
// is below the guaranteed minimum, what the service adds from its own margin.
// Every figure is the engine's breakdown of the offer price; the page only
// draws it. Without a breakdown the band is not shown.
import { formatSitePrice, type MoneyLike } from "design";
import { copy } from "../../content/copy.ts";
import type { SiteMarket } from "../../data/markets.ts";
import type { SiteBreakdownFragment } from "../../graphql/generated.ts";
import { canopy } from "../art/geometry.ts";
import { CanopyDrawing } from "../art/Sails.tsx";

export function PromiseBand({ breakdown, minimum, market }: {
  readonly breakdown: SiteBreakdownFragment;
  /** The market's guaranteed minimum, when the API gave it. */
  readonly minimum: MoneyLike | null;
  readonly market: SiteMarket;
}) {
  const write = (money: MoneyLike) => formatSitePrice(money, market);
  const artists = BigInt(breakdown.artists.amountMinor);
  const topUp = BigInt(breakdown.topUp.amountMinor);
  const fromYou = artists - topUp;
  const price = write(breakdown.price);
  const line = topUp > 0n ? copy.promise.topUp(price, write(breakdown.topUp), write(breakdown.artists)) : copy.promise.covered(price, write(breakdown.artists));
  const drawn = artists > 0n
    ? canopy(
      [{ from: 0n, to: artists, dye: "madder" }, { from: fromYou, to: artists, dye: "saffron" }],
      artists > BigInt(minimum?.amountMinor ?? 0) ? artists : BigInt(minimum?.amountMinor ?? artists),
      { ...(minimum ? { minimum: BigInt(minimum.amountMinor) } : {}), height: 104 },
    )
    : null;

  return (
    <section aria-label={copy.promise.label} className="wrap grid grid-cols-12 items-center gap-x-[clamp(1.25rem,2.4vw,2.5rem)] gap-y-6 border-t border-ink py-12">
      <p className="col-span-12 m-0 text-[clamp(1.5rem,1.05rem+1.3vw,2.25rem)] leading-[1.22] font-light tracking-[-0.015em] [font-stretch:112%] [text-wrap:pretty] lg:col-span-6">
        {line}
      </p>
      <figure className="col-span-12 m-0 grid gap-3 lg:col-span-6">
        {drawn ? <CanopyDrawing canopy={drawn} /> : null}
        <figcaption className="flex flex-wrap gap-x-6 gap-y-2 text-md">
          <span className="inline-flex items-baseline gap-[0.45rem]">
            <i className="swatch swatch-artists" />
            <b className="num">{write({ amountMinor: fromYou.toString(), currency: breakdown.artists.currency })}</b> {copy.promise.fromYou(price)}
          </span>
          {topUp > 0n ? (
            <span className="inline-flex items-baseline gap-[0.45rem]">
              <i className="swatch swatch-topup" />
              <b className="num">{write(breakdown.topUp)}</b> {copy.promise.addedBy}
            </span>
          ) : null}
          <span className="basis-full border-t border-cord pt-2 font-semibold text-madder">
            <b className="num">{write(breakdown.artists)}</b> {copy.promise.total}
            {minimum && topUp === 0n ? <span className="font-normal text-ink-2"> ({copy.promise.minimum(write(minimum))})</span> : null}
          </span>
        </figcaption>
      </figure>
    </section>
  );
}
