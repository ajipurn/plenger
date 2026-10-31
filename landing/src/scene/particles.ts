import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import fragmentShader from "./points.frag.glsl?raw";
import vertexShader from "./points.vert.glsl?raw";
import { code, emblem, field, ring, STRIDE_SEGMENTS, seededRandom } from "./shapes.ts";

/** Everything GSAP animates. The render loop copies it into uniforms and the group. */
export type SceneState = {
  morph: number;
  intro: number;
  scan: number;
  dim: number;
  x: number;
  y: number;
  scale: number;
  rotX: number;
  rotY: number;
};

export type ParticleScene = {
  state: SceneState;
  /** One value per STRIDE arc, 0 to 1. */
  segments: { value: number }[];
  render(time: number): void;
  resize(): void;
  pointer(x: number, y: number): void;
};

const BACKGROUND = "#172b36";

/** Shader colours are used as written; the output is not colour managed. */
function rgb(hex: string): Vector3 {
  const value = Number.parseInt(hex.slice(1), 16);
  return new Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

export function createParticleScene(canvas: HTMLCanvasElement, monoFont: string): ParticleScene {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(new Color(BACKGROUND), 1);

  const compact = window.matchMedia("(max-width: 767px)").matches;
  const count = compact ? 12000 : 26000;
  const random = seededRandom(7);

  const codeLayout = code(count, random, monoFont);
  const ringLayout = ring(count, 2.05, random);
  const randoms = new Float32Array(count);
  for (let i = 0; i < count; i++) randoms[i] = random();

  const geometry = new BufferGeometry();
  const emblemPositions = emblem(count, random);
  // `position` is required by three.js for bounds; the shader reads the named layouts.
  geometry.setAttribute("position", new BufferAttribute(emblemPositions, 3));
  geometry.setAttribute("aEmblem", new BufferAttribute(emblemPositions, 3));
  geometry.setAttribute("aCode", new BufferAttribute(codeLayout.positions, 3));
  geometry.setAttribute("aRing", new BufferAttribute(ringLayout.positions, 3));
  geometry.setAttribute("aField", new BufferAttribute(field(count, random), 3));
  geometry.setAttribute("aRandom", new BufferAttribute(randoms, 1));
  geometry.setAttribute("aFlag", new BufferAttribute(codeLayout.flags, 1));
  geometry.setAttribute("aSegment", new BufferAttribute(ringLayout.segments, 1));

  const segmentValues = new Array<number>(STRIDE_SEGMENTS).fill(0);
  const uniforms = {
    uTime: { value: 0 },
    uMorph: { value: 0 },
    uIntro: { value: 0 },
    uScan: { value: 0 },
    uDim: { value: 1 },
    uSize: { value: compact ? 19 : 22 },
    uPixelRatio: { value: 1 },
    uAspect: { value: 1 },
    uMouse: { value: new Vector2(9, 9) },
    uSegments: { value: segmentValues },
    uInk: { value: rgb("#f1f6f4") },
    uAccent: { value: rgb("#ffc801") },
    uSignal: { value: rgb("#ff9932") },
  };

  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  const group = new Group();
  group.add(points);

  const scene = new Scene();
  scene.add(group);
  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 9);

  const state: SceneState = {
    morph: 0,
    intro: 0,
    scan: 0,
    dim: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotX: 0,
    rotY: 0,
  };
  const segments = segmentValues.map(() => ({ value: 0 }));
  const mouse = { x: 9, y: 9, tx: 9, ty: 9, px: 0, py: 0 };

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio, compact ? 1.6 : 1.75);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    uniforms.uPixelRatio.value = ratio;
    uniforms.uAspect.value = width / height;
  }

  function pointer(x: number, y: number) {
    mouse.tx = x;
    mouse.ty = y;
  }

  function render(time: number) {
    mouse.x += (mouse.tx - mouse.x) * 0.12;
    mouse.y += (mouse.ty - mouse.y) * 0.12;
    const parallaxX = Math.abs(mouse.tx) > 2 ? 0 : mouse.tx;
    const parallaxY = Math.abs(mouse.ty) > 2 ? 0 : mouse.ty;
    mouse.px += (parallaxX - mouse.px) * 0.04;
    mouse.py += (parallaxY - mouse.py) * 0.04;

    uniforms.uTime.value = time;
    uniforms.uMorph.value = state.morph;
    uniforms.uIntro.value = state.intro;
    uniforms.uScan.value = state.scan;
    uniforms.uDim.value = state.dim;
    uniforms.uMouse.value.set(mouse.x, mouse.y);
    segments.forEach((segment, index) => {
      segmentValues[index] = segment.value;
    });

    group.position.set(state.x, state.y, 0);
    group.scale.setScalar(state.scale);
    group.rotation.set(state.rotX - mouse.py * 0.12, state.rotY + mouse.px * 0.18, 0);
    renderer.render(scene, camera);
  }

  resize();
  return { state, segments, render, resize, pointer };
}
