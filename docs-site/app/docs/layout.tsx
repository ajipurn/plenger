import { DocsLayout } from "fumadocs-ui/layouts/docs";
import Image from "next/image";
import type { ReactNode } from "react";
import { repositoryUrl } from "../../lib/content.ts";
import { pageTree } from "../../lib/source.ts";

export default function DocumentationLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="docs-skip-link" href="#nd-page">
        Skip to content
      </a>
      <DocsLayout
        tree={pageTree}
        nav={{
          title: (
            <span className="flex items-center gap-3">
              <Image
                className="docs-logo"
                src="/logo.svg"
                alt=""
                width={24}
                height={24}
                unoptimized
              />
              <span className="docs-wordmark">plenger</span>
              <span className="rounded-md border border-fd-border px-2 py-0.5 text-xs font-normal text-fd-muted-foreground">
                docs
              </span>
            </span>
          ),
          url: "/docs/",
        }}
        githubUrl={repositoryUrl}
        links={[{ text: "Home", url: "/", external: true }]}
        sidebar={{
          footer: (
            <a
              className="docs-sidebar-footer"
              href="https://www.fumadocs.dev/"
              target="_blank"
              rel="noreferrer"
            >
              Built with Fumadocs <span aria-hidden="true">↗</span>
            </a>
          ),
        }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
