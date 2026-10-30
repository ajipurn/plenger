import { dirname, relative, resolve, sep } from "node:path";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import {
  documentationContentFile,
  documentationPages,
  documentationUrl,
  repositoryUrl,
} from "./content.ts";

export function remarkRepository({ repositoryRoot }: { repositoryRoot: string }) {
  return (tree: Root, file: { path: string }) => {
    // Included Markdown can contain generator comments, which are not MDX elements.
    visit(tree, "html", (node, index, parent) => {
      if (/^\s*<!--[\s\S]*-->\s*$/.test(node.value) && index !== undefined && parent) {
        parent.children.splice(index, 1);
        return index;
      }
    });

    // The page layout supplies the title for Markdown and MDX alike.
    let removedTitle = false;
    visit(tree, "heading", (node, index, parent) => {
      if (!removedTitle && node.depth === 1 && index !== undefined && parent) {
        parent.children.splice(index, 1);
        removedTitle = true;
        return index;
      }
    });

    const page = documentationPages.find(
      (entry) =>
        resolve(repositoryRoot, "docs-site/content", documentationContentFile(entry.slug)) ===
        file.path,
    );
    const sourcePath = page ? resolve(repositoryRoot, page.file) : file.path;

    visit(tree, ["link", "definition"], (node) => {
      if (node.type !== "link" && node.type !== "definition") return;
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(node.url)) return;

      const url = new URL(node.url, "https://repository.local/");
      const target = relative(
        repositoryRoot,
        resolve(dirname(sourcePath), decodeURIComponent(node.url.split(/[?#]/, 1)[0] ?? "")),
      )
        .split(sep)
        .join("/");
      const page = documentationPages.find((entry) => entry.file === target);

      if (page && node.type === "link") {
        const label = node.children[0];
        if (node.children.length === 1 && label?.type === "text" && label.value === node.url) {
          label.value = page.title;
        }
      }

      node.url = page
        ? `${documentationUrl(page.slug)}${url.search}${url.hash}`
        : `${repositoryUrl}/${url.pathname.endsWith("/") ? "tree" : "blob"}/main/${target}${url.search}${url.hash}`;
    });
  };
}
