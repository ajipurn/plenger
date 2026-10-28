// Blends each particle between five layouts: the emblem, code, STRIDE ring, dust field
// and a smaller closing emblem. uMorph runs from 0 to 4 across the page.

attribute vec3 aEmblem;
attribute vec3 aCode;
attribute vec3 aRing;
attribute vec3 aField;
attribute float aRandom;
attribute float aFlag;
attribute float aSegment;

uniform float uTime;
uniform float uMorph;
uniform float uIntro;
uniform float uScan;
uniform float uSize;
uniform float uPixelRatio;
uniform float uAspect;
uniform vec2 uMouse;
uniform float uSegments[6];

varying float vAlpha;
varying float vScan;
varying float vFlag;
varying float vGlow;
varying float vTint;

// Simplex noise by Ashima Arts and Stefan Gustavson, MIT licence.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

mat2 rotate(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Staggered progress of one morph step, so particles leave and land at different times.
float stage(float from) {
  float t = clamp((uMorph - from) * 1.45 - aRandom * 0.45, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  float s1 = stage(0.0);
  float s2 = stage(1.0);
  float s3 = stage(2.0);
  float s4 = stage(3.0);

  // The emblem sways rather than spins, so its face and keyhole stay readable.
  vec3 emblem = aEmblem;
  emblem.xz = rotate(sin(uTime * 0.23) * 0.42) * emblem.xz;
  emblem.yz = rotate(sin(uTime * 0.17 + 1.3) * 0.12) * emblem.yz;
  emblem += vec3(
    snoise(aEmblem * 0.9 + vec3(0.0, uTime * 0.14, 0.0)),
    snoise(aEmblem.yzx * 0.9 - vec3(uTime * 0.12, 0.0, 0.0)),
    snoise(aEmblem.zxy * 0.9 + 3.1)
  ) * 0.035;

  vec3 ringPos = aRing;
  ringPos.xy = rotate(uTime * 0.035) * ringPos.xy;

  vec3 fieldPos = aField;
  fieldPos.x += cos(uTime * 0.11 + aRandom * 12.0) * 0.14;
  fieldPos.y += sin(uTime * 0.15 + aRandom * 6.2831) * 0.14;

  vec3 codePos = aCode;
  codePos.z += sin(uTime * 0.8 + aCode.x * 0.9) * 0.025;

  vec3 p = mix(emblem, codePos, s1);
  p = mix(p, ringPos, s2);
  p = mix(p, fieldPos, s3);
  p = mix(p, emblem * 0.6, s4);

  // Particles swirl while they travel and settle when they land.
  float travel = sin(3.14159 * s1) + sin(3.14159 * s2) + sin(3.14159 * s3) + sin(3.14159 * s4);
  vec3 seed = aEmblem * 1.3;
  vec3 drift = vec3(
    snoise(seed + uTime * 0.2),
    snoise(seed.yzx - uTime * 0.2),
    snoise(seed.zxy + 7.0)
  );
  p += drift * travel * 0.55;

  // On load, particles arrive from the dust field.
  float intro = clamp(uIntro * 1.6 - aRandom * 0.6, 0.0, 1.0);
  intro = 1.0 - pow(1.0 - intro, 3.0);
  p = mix(aField * 1.8, p, intro);

  // The scan line sweeps the code from top to bottom.
  float codeWeight = s1 * (1.0 - s2);
  float scanY = mix(2.45, -2.45, uScan);
  float offset = aCode.y - scanY;
  float sweeping = step(0.002, uScan) * step(uScan, 0.998);
  vScan = exp(-offset * offset * 70.0) * codeWeight * sweeping;
  vFlag = aFlag * smoothstep(-0.04, 0.04, offset) * (1.0 - s4 * 0.6);

  float highlight = 0.0;
  for (int i = 0; i < 6; i++) {
    if (abs(float(i) - aSegment) < 0.5) highlight = uSegments[i];
  }
  vGlow = highlight * s2 * (1.0 - s3);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // Push particles away from the pointer in screen space.
  vec2 delta = gl_Position.xy / gl_Position.w - uMouse;
  delta.x *= uAspect;
  float dist = length(delta);
  float push = smoothstep(0.3, 0.0, dist) * intro;
  vec2 away = delta / max(dist, 1e-4);
  away.x /= uAspect;
  gl_Position.xy += away * push * 0.05 * gl_Position.w;

  float size = uSize * (0.55 + aRandom * 0.9);
  size *= 1.0 + vFlag * 0.7 + vGlow * 0.7 + vScan * 1.2 + push * 0.8;
  size *= mix(1.0, 0.7, codeWeight);
  gl_PointSize = clamp(size * uPixelRatio / -mv.z, 0.0, 48.0);

  float depth = smoothstep(14.0, 6.0, -mv.z);
  vAlpha = mix(0.18, 1.0, depth) * mix(0.55 + aRandom * 0.45, 1.0, codeWeight) * (0.5 + intro * 0.5);
  vTint = aRandom * (1.0 - codeWeight * 0.7);
}
