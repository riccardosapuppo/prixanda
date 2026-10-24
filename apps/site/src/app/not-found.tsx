import { Icon } from "design/icon";
import type { Metadata } from "next";
import Link from "next/link";
import { copy } from "../content/copy.ts";

export const metadata: Metadata = { title: copy.notFound.title };

export default function NotFound() {
  return (
    <section className="wrap grid gap-4 py-16" aria-labelledby="not-found-title">
      <h1 id="not-found-title" className="title-2 m-0">{copy.notFound.title}</h1>
      <p className="m-0 max-w-[60ch]">{copy.notFound.body}</p>
      <p className="m-0">
        <Link href="/" className="btn">
          {copy.notFound.action}
          <Icon name="arrow-right" size={16} />
        </Link>
      </p>
    </section>
  );
}
