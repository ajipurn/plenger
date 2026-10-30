export const repositoryUrl = "https://github.com/ajipurn/plenger";

// Each public page points to its maintained source. Other repository links open on GitHub.
export const documentationPages = [
  {
    file: "docs-site/content/index.mdx",
    slug: "",
    title: "Introduction",
    description: "Review your repositories. Understand the evidence. Decide what to fix.",
    section: "Get started",
  },
  {
    file: "docs/guide/install.md",
    slug: "installation",
    title: "Installation",
    description: "Install Plenger, start the local dashboard and keep it up to date.",
    section: "Get started",
  },
  {
    file: "docs/guide/dashboard.md",
    slug: "dashboard",
    title: "Local dashboard",
    description: "Add a project, connect a model and run your first security review.",
    section: "Guides",
  },
  {
    file: "docs/guide/ai-security-review.md",
    slug: "ai-security-review",
    title: "AI security review",
    description: "Source discovery, STRIDE threat modeling and a second validation pass.",
    section: "Guides",
  },
  {
    file: "docs/guide/scanning.md",
    slug: "static-analysis",
    title: "Static analysis",
    description: "Understand inventory, capabilities, code facts and static findings.",
    section: "Guides",
  },
  {
    file: "docs/guide/reports-ci.md",
    slug: "reports-and-ci",
    title: "Reports and CI",
    description: "Export evidence and use the GitHub Action with severity gates.",
    section: "Guides",
  },
  {
    file: "docs/guide/rea-evidence.md",
    slug: "rea-evidence",
    title: "REA evidence",
    description: "Import external JavaScript and Electron evidence for a saved scan.",
    section: "Guides",
  },
  {
    file: "docs/RULES.md",
    slug: "rules",
    title: "Rule catalog",
    description: "Static rule IDs, severities, mappings and remediation guidance.",
    section: "Reference",
  },
  {
    file: "docs/STATUS.md",
    slug: "status",
    title: "Status and qualifications",
    description: "Available capabilities, release status and recorded qualification evidence.",
    section: "Reference",
  },
  {
    file: "docs/ARCHITECTURE.md",
    slug: "architecture",
    title: "Architecture",
    description: "The source layout and the path from repository files to findings.",
    section: "Contributing",
  },
  {
    file: "CONTRIBUTING.md",
    slug: "contributing",
    title: "Contributing",
    description: "Set up the toolchain, run checks and contribute changes.",
    section: "Contributing",
  },
  {
    file: "docs/ROADMAP.md",
    slug: "roadmap",
    title: "Roadmap",
    description: "Product goals, design principles and planned work.",
    section: "Contributing",
  },
] as const;

export function documentationUrl(slug: string): string {
  return slug ? `/docs/${slug}/` : "/docs/";
}

export function documentationContentFile(slug: string): string {
  return `${slug || "index"}.mdx`;
}
