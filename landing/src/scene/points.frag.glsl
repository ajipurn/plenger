uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uSignal;
uniform float uDim;

varying float vAlpha;
varying float vScan;
varying float vFlag;
varying float vGlow;
varying float vTint;

void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  a *= a;

  vec3 color = mix(uInk, uAccent, smoothstep(0.35, 1.0, vTint));
  color = mix(color, uAccent * 1.25, vScan);
  color = mix(color, uSignal, vFlag);
  color = mix(color, mix(uAccent, uInk, 0.35), vGlow);

  float alpha = a * vAlpha * uDim * (1.0 + vFlag * 0.6 + vGlow * 0.25);
  gl_FragColor = vec4(color, alpha);
}
