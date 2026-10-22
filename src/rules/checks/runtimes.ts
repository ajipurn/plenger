import {
  type Exposure,
  exposure,
  fixedReleases,
  oldestFixedBranch,
  RUNTIME_ADVISORIES,
  type RuntimeAdvisory,
  versionText,
} from "../../platform/advisories.ts";
import type {
  Platform,
  RuntimeImage,
  RuntimePackages,
  RuntimePlatform,
  RuntimeSetting,
  ServerApi,
} from "../../platform/model.ts";
import { type Draft, SEVERITIES, type Severity } from "../model.ts";
import { code, listed } from "../text.ts";

/** How many places a note lists where a mitigation is set. */
const NOTE_PLACES = 3;

/**
 * PLG001–PLG003: runtimes the project deploys on that a runtime advisory affects, and
 * mitigations set where they do not take effect.
 */
export function runtimeChecks(platform: Platform): Draft[] {
  const drafts: Draft[] = [];
  for (const advisory of RUNTIME_ADVISORIES) {
    const mitigations = platform.settings.filter(
      (setting) =>
        setting.runtime === advisory.runtime &&
        setting.name === advisory.mitigation.setting &&
        setting.enabled === advisory.mitigation.enabled,
    );
    const effective = mitigations.filter((setting) => setting.scope === "startup");
    const declarations = platform.declarations.filter((item) => item.runtime === advisory.runtime);
    // A dependency manager's platform says less than an image or package that ships the runtime.
    const shipped = declarations.some((item) => item.kind !== "platform");
    for (const declaration of declarations) {
      const draft =
        declaration.kind === "image"
          ? imageDraft(advisory, declaration)
          : declaration.kind === "packages"
            ? packagesDraft(advisory, declaration)
            : shipped
              ? null
              : platformDraft(advisory, declaration);
      if (draft === null) continue;
      draft.notes.push(mitigationNote(advisory, effective));
      drafts.push(draft);
    }
    for (const setting of mitigations)
      if (setting.scope !== "startup") drafts.push(lateSettingDraft(advisory, setting, effective));
  }
  return drafts;
}

function imageDraft(advisory: RuntimeAdvisory, image: RuntimeImage): Draft | null {
  const found = exposure(advisory, image.version);
  if (found.kind === "unaffected") return null;
  const name = code(image.reference);
  const version = image.version === null ? null : versionText(image.version);
  const base = {
    location: image.location,
    subject: { kind: "runtime" as const, name: image.reference },
    exposed: image.api !== "cli",
    key: [advisory.name, image.reference],
  };
  const notes = [advisoryNote(advisory, found), ...apiNote(image.api, "image")];
  if (found.kind === "vulnerable" || found.kind === "end_of_life") {
    const title =
      found.kind === "vulnerable"
        ? `Image ${name} ships PHP ${version}, which ${advisory.name} affects`
        : `Image ${name} ships PHP ${version}, an end-of-life branch without a ${advisory.name} fix`;
    const message =
      found.kind === "vulnerable"
        ? `PHP ${version}; ${advisory.name} is fixed in ${found.fix}`
        : `PHP ${version}; end of life`;
    return {
      rule: "PLG001",
      title,
      severity: lowered("critical", image.api),
      confidence: "high",
      evidence: [{ location: image.location, message }],
      notes,
      ...base,
    };
  }
  const title =
    image.hidden === "application"
      ? `Image ${name} bundles a PHP release its tag does not show`
      : image.hidden === "variable"
        ? `Image ${name} takes its PHP version from a variable without a default`
        : `Image ${name} takes its PHP release when it is built`;
  return {
    rule: "PLG002",
    title,
    severity: lowered("medium", image.api),
    confidence: "medium",
    evidence: [
      { location: image.location, message: `PHP ${version ?? "release"} decided at build time` },
    ],
    notes,
    ...base,
  };
}

function packagesDraft(advisory: RuntimeAdvisory, packages: RuntimePackages): Draft | null {
  const found = exposure(advisory, packages.version);
  if (found.kind === "unaffected") return null;
  const notes = [
    advisoryNote(advisory, found.kind === "end_of_life" ? { kind: "floating", fix: null } : found),
    "Distributions backport fixes without changing the upstream version; the distribution's security tracker says which package release holds the fix.",
  ];
  if (found.kind === "end_of_life" && packages.version !== null)
    notes.push(
      `PHP ${versionText(packages.version)} is end of life upstream; only the distribution's own backport fixes it.`,
    );
  notes.push(...apiNote(packages.api, "build"));
  return {
    rule: "PLG002",
    title: `${code(packages.manager)} installs PHP (${code(packages.package)}) at the distribution's patch level`,
    severity: lowered("medium", packages.api),
    confidence: "medium",
    location: packages.location,
    subject: { kind: "runtime", name: `${packages.manager} ${packages.package}` },
    evidence: [{ location: packages.location, message: "PHP from distribution packages" }],
    notes,
    exposed: packages.api !== "cli",
    key: [advisory.name, packages.manager, packages.package],
  };
}

/** Only an end-of-life branch: a dependency manager's platform is often a minimum, not the release in production. */
function platformDraft(advisory: RuntimeAdvisory, platform: RuntimePlatform): Draft | null {
  if (exposure(advisory, platform.version).kind !== "end_of_life") return null;
  const version = versionText(platform.version);
  return {
    rule: "PLG001",
    title: `${code("composer.json")} resolves dependencies for PHP ${version}, an end-of-life branch without a ${advisory.name} fix`,
    severity: "high",
    confidence: "low",
    location: platform.location,
    subject: { kind: "runtime", name: `composer platform php ${platform.text}` },
    evidence: [{ location: platform.location, message: `\`config.platform.php\` is ${version}` }],
    notes: [
      advisoryNote(advisory, { kind: "end_of_life" }),
      "No image or package in the repository declares the PHP release; the one in production may be newer than the platform the dependencies are resolved for.",
    ],
    exposed: false,
    key: [advisory.name, "platform"],
  };
}

function lateSettingDraft(
  advisory: RuntimeAdvisory,
  setting: RuntimeSetting,
  effective: RuntimeSetting[],
): Draft {
  const where = setting.scope === "ini_set" ? code("ini_set()") : code(".user.ini");
  const notes = [
    setting.scope === "ini_set"
      ? `${code(setting.name)} can only be changed before a request starts, so ${code("ini_set()")} returns false and leaves the value as it was.`
      : `The ${advisory.name} guidance warns that ${code(".user.ini")} applies ${code(setting.name)} too late.`,
  ];
  if (effective.length > 0)
    notes.push(`It is also turned off where it takes effect: ${places(effective)}.`);
  return {
    rule: "PLG003",
    title: `${where} turns off ${code(setting.name)} where it does not take effect`,
    severity: effective.length > 0 ? "low" : "medium",
    confidence: "high",
    location: setting.location,
    subject: { kind: "runtime", name: setting.name },
    evidence: [{ location: setting.location, message: `${advisory.name} mitigation in ${where}` }],
    notes,
    exposed: false,
    key: [advisory.name, setting.scope, setting.name],
  };
}

function advisoryNote(advisory: RuntimeAdvisory, found: Exposure): string {
  const header = `${advisory.name} (${advisory.cves.join(", ")}, published ${advisory.published})`;
  if (found.kind === "end_of_life")
    return `${header} is fixed in ${listed(fixedReleases(advisory))}; branches older than ${oldestFixedBranch(advisory)} get no fix from php.net.`;
  const fix = "fix" in found && found.fix !== null ? found.fix : listed(fixedReleases(advisory));
  if (found.kind === "vulnerable") return `${header} is fixed in ${fix}.`;
  return `${header} is fixed in ${fix}. A build from before ${advisory.published} does not hold the fix.`;
}

function mitigationNote(advisory: RuntimeAdvisory, effective: RuntimeSetting[]): string {
  const setting = code(advisory.mitigation.setting);
  if (effective.length === 0)
    return `No configuration in the repository turns ${setting} off before a request is parsed; PHP turns it on by default.`;
  return `${setting} is turned off in ${places(effective)}. That closes the known paths of ${advisory.name}, not every variant, and holds only where that configuration is deployed; the fixed release is still needed.`;
}

function apiNote(api: ServerApi, of: "image" | "build"): string[] {
  const subject = of === "image" ? "The image" : "The build";
  if (api === "apache") return [`${subject} serves PHP through Apache with mod_php.`];
  if (api === "fpm") return [`${subject} serves PHP through PHP-FPM.`];
  if (api === "cli")
    return [
      `${subject} runs the PHP CLI, which is affected only when it serves HTTP, for example with ${code("php -S")}.`,
    ];
  return [];
}

function places(settings: RuntimeSetting[]): string {
  const shown = settings
    .slice(0, NOTE_PLACES)
    .map((item) => `${item.location.path}:${item.location.line}`);
  const more = settings.length - shown.length;
  return listed(more > 0 ? [...shown, `${more} more`] : shown);
}

/** The CLI serves no requests unless it runs a server itself: one severity lower. */
function lowered(severity: Severity, api: ServerApi): Severity {
  if (api !== "cli") return severity;
  return SEVERITIES[Math.min(SEVERITIES.indexOf(severity) + 1, SEVERITIES.length - 1)] ?? severity;
}
