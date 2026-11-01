# Documentation site

The Plenger documentation uses Fumadocs UI and MDX with Next.js. It exports
static HTML and a browser search index. It is outside the npm package.

```sh
pnpm docs:dev         # http://127.0.0.1:4192/docs/
pnpm docs:build       # static output in docs-site/out
```

The page list, navigation and routes live in `lib/content.ts`. Pages read their
maintained Markdown directly from `docs/` and `CONTRIBUTING.md`. The introduction
is `content/index.mdx`. Edit the original document to update a guide. Do not copy
or edit the generated rule catalog.

MDX files in `content/` include the original documents. The content watcher stays
inside this directory. `lib/remark-repository.ts` removes the
first Markdown title, which the page layout renders, and resolves repository
links. Published guides link to their documentation route. Other files link to
GitHub. Generated Fumadocs and Next.js files are ignored.

`pnpm check` includes the site's typecheck. Deploy `docs-site/out` to a static
host that serves directory index files. The root redirects to `/docs/`, and the
logo and favicon come from `public/`.
