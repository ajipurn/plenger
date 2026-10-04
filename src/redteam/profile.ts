import type { ProjectPlan } from "./plan.ts";

/** A source-review candidate does not imply that its runtime is supported. */
export function fileCanaryBlocker(plan: ProjectPlan): string | null {
  if (plan.nextProfile) return "This target uses the Next.js booking/SQLite profile.";
  if (!plan.selectedTarget || plan.preparation.status !== "ready")
    return "Select a ready llmfy target to use this preview.";
  if (!plan.dependencies.llmfy.matchesSyntheticBaseline)
    return "This preview requires llmfy==0.11.0.";
  if (plan.sources.files.reduce((total, file) => total + file.bytes, 0) > 4 * 1024 * 1024)
    return "This preview supports up to 4 MiB of captured Python source.";
  if (
    plan.dependencies.packages.some((item) => item.name !== "llmfy" || item.extras.length > 0) ||
    plan.dependencies.requiresPython !== null
  )
    return "Additional dependencies and Python version constraints need another runtime profile.";
  return null;
}

export function runBlocker(plan: ProjectPlan): string | null {
  if (!plan.nextProfile) return fileCanaryBlocker(plan);
  if (!plan.selectedTarget || plan.preparation.status !== "ready")
    return "Review a supported Next.js booking route before running.";
  return null;
}
