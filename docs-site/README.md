# Documentation site

The Plenger documentation uses Fumadocs UI and MDX with Next.js. It exports
static HTML and a browser search index. It is outside the npm package.

```sh
pnpm docs:dev         # http://127.0.0.1:4192/docs/
pnpm docs:build       # static output in docs-site/out
pnpm site:build       # landing and documentation together in landing/dist
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

`pnpm check` includes the site's typecheck. `pnpm site:build` builds both sites
and copies the documentation routes and Next.js assets into `landing/dist`.
Deploy that directory to a static host that serves directory index files.

For development through the landing page, run `pnpm docs:dev` and `pnpm landing`
in separate terminals. The landing server forwards `/docs` and `/_next` to the
documentation server. Open `http://127.0.0.1:4190/docs/`.
