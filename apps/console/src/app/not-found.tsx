// An address the console has no page for: said plainly, with the way back,
// and, as on every page, the demo's words and in the sandbox the line on
// where the data stays (business book §13.3).
import { BRAND, DISCLAIMER } from "design";
import { Icon } from "design/icon";
import Link from "next/link";
import { SandboxFoot } from "../components/sandbox.tsx";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-screen flex-col bg-stone">
      <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-10 md:px-6 md:py-16">
        <p className="grid gap-0.5">
          <span className="font-archivo text-5xl font-bold leading-tight tracking-[-0.015em] text-ink [font-stretch:125%]">{BRAND.platform}</span>
          <span className="text-sm text-ink-2">The console of {BRAND.service}</span>
        </p>
        <h1 className="page-title mt-4">Nothing at this address</h1>
        <p>The console has no page here. <Link href="/">Back to the home</Link>.</p>
        <p className="flex items-baseline gap-2 text-sm text-ink-2">
          <Icon name="info" size={15} className="translate-y-0.5" />
          {DISCLAIMER}
        </p>
      </div>
      <SandboxFoot />
    </main>
  );
}
