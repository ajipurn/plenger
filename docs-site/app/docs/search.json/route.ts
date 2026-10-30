import { createFromSource } from "fumadocs-core/search/server";
import { documentationPages } from "../../../lib/content.ts";
import { source } from "../../../lib/source.ts";

export const dynamic = "force-static";
export const { staticGET: GET } = createFromSource(source, {
  buildIndex(page) {
    const entry = documentationPages.find((item) => item.file === page.path);
    return {
      id: page.url,
      url: page.url,
      title: page.data.title,
      description: page.data.description ?? "",
      structuredData: page.data.structuredData,
      breadcrumbs: entry ? [entry.section] : [],
    };
  },
});
