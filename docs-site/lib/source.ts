import type { Root } from "fumadocs-core/page-tree";
import { loader } from "fumadocs-core/source";
import { docs } from "../.source/server.ts";
import { documentationContentFile, documentationPages, documentationUrl } from "./content.ts";

export const source = loader({
  baseUrl: "/docs",
  source: {
    files: docs.toFumadocsSource().files.map((file) => {
      const page = documentationPages.find(
        (entry) => documentationContentFile(entry.slug) === file.path,
      );
      return page && file.type === "page"
        ? {
            ...file,
            path: page.file,
            data: { ...file.data, title: page.title, description: page.description },
          }
        : file;
    }),
  },
  slugs: (file) => {
    const page = documentationPages.find((entry) => entry.file === file.path);
    if (!page) throw new Error(`Missing documentation route: ${file.path}`);
    return page.slug ? page.slug.split("/") : [];
  },
});

export const pageTree: Root = {
  name: "Documentation",
  children: [...new Set(documentationPages.map((page) => page.section))].flatMap((section) => [
    { type: "separator" as const, name: section },
    ...documentationPages
      .filter((page) => page.section === section)
      .map((page) => ({
        type: "page" as const,
        name: page.title,
        url: documentationUrl(page.slug),
      })),
  ]),
};
