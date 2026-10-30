import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { repositoryUrl } from "../../../lib/content.ts";
import { source } from "../../../lib/source.ts";

type PageProps = { params: Promise<{ slug?: string[] }> };

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}

export default async function Page({ params }: PageProps) {
  const page = source.getPage((await params).slug);
  if (!page) notFound();
  const Body = page.data.body;

  return (
    <DocsPage toc={page.data.toc} tabIndex={-1}>
      <div>
        <p className="docs-eyebrow">Plenger documentation</p>
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
      </div>
      <DocsBody>
        <Body components={defaultMdxComponents} />
      </DocsBody>
      <EditOnGitHub href={`${repositoryUrl}/edit/main/${page.path}`} />
    </DocsPage>
  );
}
