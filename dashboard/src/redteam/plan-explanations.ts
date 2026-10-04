import { capitalize } from "../shared/format.ts";

const planExplanations: Record<string, string> = {
  "target-selection-required":
    "Choose one of the candidate entry points below to continue this review.",
  "no-candidate-target": "No entry point meets the current llmfy preparation requirements.",
  "dependency-review-required": "Dependency declarations need attention. Review the details below.",
  "source-file-limit": "Source capture reached its file limit, so this review is incomplete.",
  "source-syntax-errors":
    "Some source files could not be parsed fully, so this review may be incomplete.",
  "source-preparation-gaps":
    "Some source files could not be captured. Review the omitted files below.",
  "no-callable-entry-point":
    "An agent was found, but its callable entry point could not be identified.",
  "not-a-module-function":
    "Automatic preparation currently supports functions defined at the module's top level.",
  "not-a-public-function": "Automatic preparation currently supports public functions only.",
  "decorated-function": "Automatic preparation does not support decorated entry points yet.",
  "ambiguous-symbol": "The entry-point symbol could not be identified unambiguously.",
  "factory-needs-arguments":
    "This factory takes arguments that automatic preparation cannot supply yet.",
  "input-mapping-required":
    "This function's arguments cannot be mapped automatically to a test input yet.",
  "source-has-syntax-errors": "The entry-point source contains syntax errors.",
  "agent-has-syntax-errors": "The agent's source contains syntax errors.",
  "ambiguous-factory-return":
    "The factory can return different values, so its agent could not be selected unambiguously.",
  "outside-python-profile": "This file is outside the current Python-only preparation support.",
  "sensitive-source-path":
    "This source path may contain credentials and was excluded from capture.",
  "embedded-credential": "This file contains a recognized credential and was excluded from review.",
  "total-byte-limit":
    "Source capture reached its total size limit before this file could be included.",
  "outside-project": "This file resolves outside the selected project.",
  "not-a-single-regular-file": "This path is not a regular file or has multiple hard links.",
  "linked-path": "This path contains a symbolic link and was excluded from capture.",
  "too-large": "This file exceeds the review size limit.",
  too_large: "This file exceeds the review size limit.",
  "file-changed": "This file changed during capture. Refresh the plan to review it again.",
  "not-utf8-text": "This file could not be read as UTF-8 text.",
  unreadable: "This path could not be read.",
  missing: "This file was not found.",
  symlink: "Symbolic links are excluded from source capture.",
  gitignored: "Excluded by the project's ignore rules.",
  gitignore: "Excluded by the project's ignore rules.",
  default: "Dependency, build, cache, or version-control directory excluded from review.",
  virtualenv: "Python environment excluded from review.",
  declaration: "Type declaration files are excluded from source review.",
  minified: "Minified source files are excluded from review.",
  "unsupported-dependency-declaration":
    "This dependency declaration is not supported by the current review.",
  "poetry-metadata-not-supported":
    "Poetry dependency metadata is not supported by the current review.",
  "custom-dependency-source-not-supported":
    "Custom package sources are not supported by the current review.",
  "dynamic-dependencies-not-supported":
    "Dependencies computed by project code cannot be reviewed automatically yet.",
  "invalid-dependencies": "The dependency list does not have the expected format.",
  "unsupported-python-constraint":
    "The declared Python version constraint is not supported by the current review.",
  "invalid-toml": "The TOML manifest could not be parsed.",
  "llmfy-dependency-not-declared":
    "No llmfy dependency declaration was found in the reviewed manifests.",
  "llmfy-version-unresolved": "The reviewed declarations do not identify one exact llmfy version.",
  "llmfy-version-not-qualified": "The declared llmfy version has not been qualified by Plenger.",
  read: "Reviewed successfully.",
};

export function explainPlanValue(value: string): string {
  if (value.startsWith("conflicting-dependency:")) {
    return `Different constraints were declared for ${value.slice("conflicting-dependency:".length)}; compatibility has not been resolved.`;
  }
  const explanation = planExplanations[value];
  if (explanation) return explanation;
  const words = value.replaceAll(/[-_]/g, " ");
  return words ? capitalize(words) : "No additional details available.";
}

const pendingExplanations: Record<string, string> = {
  "Qualify required data/configuration resources; the snapshot contains Python source only.":
    "Project data and configuration files need support beyond the file-test preview.",
  "Resolve and qualify dependencies, Python version and project layout; lockfiles are not resolved yet.":
    "Additional dependencies, Python constraints and layouts need qualified runtime profiles.",
  "Verify input/output mapping and bind compatible built-in test packs and effect hooks.":
    "Broader test packs need compatible input mapping and observable action boundaries.",
  "Replace any embedded access with managed access; static secret recognition is not exhaustive.":
    "Broader model adapters need managed access. Offline review does not transfer project credentials.",
  "Select provider access and enforce run-wide call/token limits through the managed network path.":
    "Qualify live-model availability and usage accounting through the shared budget and broker.",
  "Qualify the live-model runtime; this plan contains no executable test cases yet.":
    "The file-test preview still needs qualification with a real model before M6a is complete.",
};

export function explainPendingItem(item: string): string {
  return pendingExplanations[item] ?? explainPlanValue(item);
}
