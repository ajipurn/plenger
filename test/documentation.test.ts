import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { documentationPages, documentationUrl } from "../docs-site/lib/content.ts";
import { remarkRepository } from "../docs-site/lib/remark-repository.ts";

describe("documentation routes", () => {
  it("assigns every maintained document a unique public URL", () => {
    const paths = documentationPages.map((page) => page.file);
    const urls = documentationPages.map((page) => documentationUrl(page.slug));
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain("/docs/");
  });
});

describe("repository Markdown", () => {
  it("resolves included documents from their maintained source directory", () => {
    const repositoryRoot = resolve(".");
    const transform = remarkRepository({ repositoryRoot });
    const link = {
      type: "link" as const,
      url: "docs/STATUS.md",
      children: [{ type: "text" as const, value: "Release status" }],
    };
    const tree = {
      type: "root" as const,
      children: [{ type: "paragraph" as const, children: [link] }],
    };

    transform(tree, { path: resolve(repositoryRoot, "docs-site/content/contributing.mdx") });

    expect(link.url).toBe("/docs/status/");
    expect(link.children[0]?.value).toBe("Release status");
  });

  it("uses a page title when the Markdown link label is a raw file path", () => {
    const repositoryRoot = resolve(".");
    const transform = remarkRepository({ repositoryRoot });
    const link = {
      type: "link" as const,
      url: "../STATUS.md",
      children: [{ type: "text" as const, value: "../STATUS.md" }],
    };
    const tree = {
      type: "root" as const,
      children: [{ type: "paragraph" as const, children: [link] }],
    };

    transform(tree, { path: resolve(repositoryRoot, "docs/guide/install.md") });

    expect(link.url).toBe("/docs/status/");
    expect(link.children[0]?.value).toBe("Status and qualifications");
  });

  it("resolves published guides locally and other repository files on GitHub", () => {
    const repositoryRoot = resolve(".");
    const transform = remarkRepository({ repositoryRoot });
    const tree = {
      type: "root" as const,
      children: [
        { type: "html" as const, value: "<!-- Generated. Do not edit. -->" },
        {
          type: "heading" as const,
          depth: 1 as const,
          children: [{ type: "text" as const, value: "Install" }],
        },
        { type: "definition" as const, identifier: "status", url: "../STATUS.md#npm-distribution" },
        {
          type: "definition" as const,
          identifier: "dashboard",
          url: "dashboard.md?view=all#start",
        },
        { type: "definition" as const, identifier: "policy", url: "../../SECURITY.md" },
        { type: "definition" as const, identifier: "external", url: "https://example.com/page.md" },
        { type: "definition" as const, identifier: "anchor", url: "#npm" },
      ],
    };

    transform(tree, { path: resolve(repositoryRoot, "docs/guide/install.md") });

    expect(tree.children).toEqual([
      { type: "definition", identifier: "status", url: "/docs/status/#npm-distribution" },
      { type: "definition", identifier: "dashboard", url: "/docs/dashboard/?view=all#start" },
      {
        type: "definition",
        identifier: "policy",
        url: "https://github.com/ajipurn/plenger/blob/main/SECURITY.md",
      },
      { type: "definition", identifier: "external", url: "https://example.com/page.md" },
      { type: "definition", identifier: "anchor", url: "#npm" },
    ]);
  });
});
