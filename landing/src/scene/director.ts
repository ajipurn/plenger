import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { ParticleScene, SceneState } from "./particles.ts";

type Target = Pick<SceneState, "morph" | "dim" | "x" | "y" | "scale" | "rotX" | "rotY">;

const SCENES = [
  "sphere",
  "code-idle",
  "code",
  "ring",
  "field",
  "field-dim",
  "orb",
  "orb-center",
] as const;
type SceneName = (typeof SCENES)[number];

/** Wide screens keep text on the left and the shape on the right. */
const WIDE: Record<SceneName, Target> = {
  sphere: { morph: 0, dim: 1, x: 2.1, y: 0, scale: 0.74, rotX: 0, rotY: 0 },
  "code-idle": { morph: 1, dim: 0.28, x: 2.6, y: -0.2, scale: 0.54, rotX: 0.05, rotY: -0.7 },
  code: { morph: 1, dim: 1, x: 2, y: 0, scale: 0.6, rotX: 0.04, rotY: -0.3 },
  ring: { morph: 2, dim: 1, x: 2.1, y: 0, scale: 0.76, rotX: -0.18, rotY: -0.42 },
  field: { morph: 3, dim: 0.8, x: 0, y: 0, scale: 0.9, rotX: 0, rotY: 0 },
  "field-dim": { morph: 3, dim: 0.35, x: 0, y: 0, scale: 0.9, rotX: 0, rotY: 0 },
  orb: { morph: 4, dim: 1, x: 2.35, y: 0, scale: 0.8, rotX: 0, rotY: 0 },
  "orb-center": { morph: 4, dim: 0.55, x: 0, y: 0.1, scale: 0.92, rotX: 0, rotY: 0 },
};

/** Phones stack everything, so shapes shrink, centre and sit behind the copy. */
const COMPACT: Record<SceneName, Target> = {
  sphere: { morph: 0, dim: 0.85, x: 0, y: 1.1, scale: 0.5, rotX: 0, rotY: 0 },
  "code-idle": { morph: 1, dim: 0.18, x: 0, y: -1.3, scale: 0.32, rotX: 0, rotY: -0.2 },
  code: { morph: 1, dim: 0.8, x: 0, y: 0.78, scale: 0.28, rotX: 0.04, rotY: -0.12 },
  ring: { morph: 2, dim: 0.45, x: 0, y: 1.5, scale: 0.44, rotX: -0.18, rotY: -0.3 },
  field: { morph: 3, dim: 0.75, x: 0, y: 0, scale: 0.55, rotX: 0, rotY: 0 },
  "field-dim": { morph: 3, dim: 0.35, x: 0, y: 0, scale: 0.55, rotX: 0, rotY: 0 },
  orb: { morph: 4, dim: 0.35, x: 0, y: 1.9, scale: 0.6, rotX: 0, rotY: 0 },
  "orb-center": { morph: 4, dim: 0.5, x: 0, y: 0.3, scale: 0.62, rotX: 0, rotY: 0 },
};

function isSceneName(value: string | undefined): value is SceneName {
  return SCENES.some((name) => name === value);
}

/**
 * Moves the particle scene to the layout of the last section whose top has crossed 60%
 * of the viewport. Reading positions on every update, rather than toggles, keeps the
 * scene right after a jump that skips a whole section.
 */
export function directScenes(scene: ParticleScene, reduced: boolean) {
  const compactQuery = window.matchMedia("(max-width: 899px)");
  let current: SceneName = "sphere";

  const go = (name: SceneName, immediate = false) => {
    current = name;
    const target = (compactQuery.matches ? COMPACT : WIDE)[name];
    gsap.to(scene.state, {
      ...target,
      duration: reduced || immediate ? 0 : 2.2,
      ease: "power3.inOut",
      overwrite: "auto",
    });
  };

  const marks: { name: SceneName; trigger: ScrollTrigger }[] = [];
  for (const section of document.querySelectorAll<HTMLElement>("[data-scene]")) {
    const name = section.dataset.scene;
    if (isSceneName(name)) {
      marks.push({ name, trigger: ScrollTrigger.create({ trigger: section, start: "top 60%" }) });
    }
  }

  const pick = (scroll: number) => {
    let name: SceneName = "sphere";
    for (const mark of marks) if (scroll >= mark.trigger.start) name = mark.name;
    if (name !== current) go(name);
  };

  ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: (self) => pick(self.scroll()),
    onRefresh: (self) => pick(self.scroll()),
  });
  compactQuery.addEventListener("change", () => go(current, true));
  go(current, true);
}
