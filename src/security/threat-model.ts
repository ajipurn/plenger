import { type ProjectThreatModel, THREAT_MODEL_LIMITS } from "./model.ts";

/** The parts of a threat model a review reads and writes. */
export type ThreatModelContent = Pick<
  ProjectThreatModel,
  "architecture" | "assets" | "trustBoundaries"
>;

/**
 * A model extended by one review. The review was given the model and told to keep and
 * extend it, so its architecture replaces the model's; assets and trust boundaries are
 * merged in order, without repeats, within the limits.
 */
export function extendThreatModel(
  model: ThreatModelContent | null,
  review: ThreatModelContent,
): ThreatModelContent {
  const merge = (first: readonly string[], second: readonly string[]) => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const item of [...first, ...second]) {
      const text = item.trim().slice(0, THREAT_MODEL_LIMITS.itemCharacters);
      const key = text.toLowerCase();
      if (!text || seen.has(key) || merged.length >= THREAT_MODEL_LIMITS.items) continue;
      seen.add(key);
      merged.push(text);
    }
    return merged;
  };
  const architecture = review.architecture.trim() || model?.architecture || "";
  return {
    architecture: architecture.slice(0, THREAT_MODEL_LIMITS.textCharacters),
    assets: merge(model?.assets ?? [], review.assets),
    trustBoundaries: merge(model?.trustBoundaries ?? [], review.trustBoundaries),
  };
}
