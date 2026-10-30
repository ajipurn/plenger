import { resolve } from "node:path";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";
import { remarkRepository } from "./lib/remark-repository.ts";

export const docs = defineDocs({
  dir: "content",
  docs: {
    schema: pageSchema.extend({ title: z.string().default("Documentation") }),
  },
  meta: { files: [] },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkRepository, { repositoryRoot: resolve("..") }]],
  },
});
