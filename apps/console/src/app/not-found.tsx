import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto grid max-w-2xl gap-4 px-4 py-16">
      <h1 className="page-title">Nothing at this address</h1>
      <p>The console has no page here. <Link href="/">Back to the home</Link>.</p>
    </main>
  );
}
