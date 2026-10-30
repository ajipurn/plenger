import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-6">
      <p className="docs-eyebrow">404</p>
      <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-fd-muted-foreground">This documentation page does not exist.</p>
      <Link className="w-fit rounded-lg border border-fd-border px-4 py-2 text-sm" href="/docs/">
        Open documentation
      </Link>
    </main>
  );
}
