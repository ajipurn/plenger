import { LLMFY_RUNTIME, SOURCE_BYTE_CAP } from "./constants.ts";
import type { ProjectPlan } from "./plan-model.ts";

/** A source-review candidate does not imply that its runtime is supported. */
function fileCanaryBlocker(plan: ProjectPlan): string | null {
  if (plan.nextProfile) return "This target uses the Next.js booking/SQLite profile.";
  if (!plan.selectedTarget || plan.preparation.status !== "ready")
    return "Select a ready llmfy target to use this preview.";
  if (!plan.dependencies.llmfy.matchesSyntheticBaseline)
    return `This preview requires llmfy==${LLMFY_RUNTIME.llmfy}.`;
  if (plan.sources.files.reduce((total, file) => total + file.bytes, 0) > SOURCE_BYTE_CAP)
    return "This preview supports up to 4 MiB of captured Python source.";
  if (
    plan.dependencies.packages.some((item) => item.name !== "llmfy" || item.extras.length > 0) ||
    plan.dependencies.requiresPython !== null
  )
    return "Additional dependencies and Python version constraints need another runtime profile.";
  const target = plan.targets.find((item) => item.id === plan.selectedTarget);
  if (
    !target?.packs.some(
      (pack) => pack.profile === "llmfy-file-canary-v1" && pack.status === "bound",
    )
  )
    return "The file-canary tests need a synchronous tool that writes model-supplied content to a model-chosen path. This target's tools do not provide one, so the tests do not apply.";
  return null;
}

/** Why a plan cannot run in its profile's managed runtime, or null when it can. */
export function runBlocker(plan: ProjectPlan): string | null {
  if (!plan.nextProfile) return fileCanaryBlocker(plan);
  if (!plan.selectedTarget || plan.preparation.status !== "ready")
    return "Review a supported Next.js booking route before running.";
  return null;
}
