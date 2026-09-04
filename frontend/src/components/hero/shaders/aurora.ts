/**
 * GLSL for the hero field, kept out of the component so shaders can be
 * iterated on without touching React. Two programs live here:
 *
 *  - aurora: a full-screen mesh gradient of drifting blooms on paper white
 *  - packet: a GPU-animated stream of "packets" crossing the buyer/merchant wire
 *
 * Both write clip space directly from the vertex shader, so neither depends
 * on the camera or on any projection matrix staying in sync.
 */

/** Ashima 2D simplex — cheap, artefact-free at this scale. */
export const NOISE_2D = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                            + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                            dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

export const auroraVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const auroraFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;
  uniform float uProgress;
  uniform vec2  uPointer;
  uniform float uIntensity;

  ${NOISE_2D}

  void main() {
    vec2 st = vUv - 0.5;
    st.x *= uAspect;

    // Scrolling in tightens the field toward the viewer.
    st *= 1.0 - uProgress * 0.38;
    st += uPointer * 0.045;

    float t = uTime * 0.11;

    // A mesh gradient of four drifting blooms rather than a warped noise
    // field. Domain warping looked spectacular in isolation, but its detail
    // lands at roughly the size of a glyph, so body copy sat in visual noise.
    // Blooms this large can only ever vary *behind* a whole paragraph.
    // Noise survives at tiny amplitude, purely to stop the blooms from
    // reading as four perfect circles.
    vec2 wobble = vec2(snoise(st * 1.6 + t * 0.4), snoise(st * 1.6 - t * 0.3));
    vec2 p = st + wobble * 0.035;

    vec2 c1 = vec2(-0.28 + sin(t * 0.61) * 0.10,  0.16 + cos(t * 0.44) * 0.07);
    vec2 c2 = vec2( 0.30 + cos(t * 0.53) * 0.11,  0.22 + sin(t * 0.37) * 0.08);
    vec2 c3 = vec2( 0.10 + sin(t * 0.42) * 0.13, -0.24 + cos(t * 0.58) * 0.09);
    vec2 c4 = vec2(-0.34 + cos(t * 0.35) * 0.09, -0.18 + sin(t * 0.49) * 0.10);

    float d1 = smoothstep(0.62, 0.0, distance(p, c1));
    float d2 = smoothstep(0.55, 0.0, distance(p, c2));
    float d3 = smoothstep(0.48, 0.0, distance(p, c3));
    float d4 = smoothstep(0.44, 0.0, distance(p, c4));

    vec3 paper  = vec3(1.0);
    vec3 pale   = vec3(0.878, 0.918, 1.000);
    vec3 sky    = vec3(0.678, 0.784, 1.000);
    vec3 brand  = vec3(0.373, 0.545, 1.000); // #5F8BFF, lifted from #305EFF
    vec3 violet = vec3(0.678, 0.596, 0.980);

    vec3 col = paper;
    col = mix(col, pale,   d1 * 0.85 * uIntensity);
    col = mix(col, sky,    d2 * 0.50 * uIntensity);
    col = mix(col, brand,  d3 * 0.26 * uIntensity);
    col = mix(col, violet, d4 * 0.24 * uIntensity);

    // Dissolve to paper at the edges: no seam where the canvas ends.
    float vig = smoothstep(1.18, 0.32, length((vUv - 0.5) * vec2(1.28, 1.62)));
    col = mix(paper, col, vig);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const packetVertex = /* glsl */ `
  attribute float aSeed;
  attribute float aLane;
  attribute float aSpeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uDpr;
  uniform float uProgress;
  uniform float uAspect;

  varying float vAlpha;
  varying float vTone;

  void main() {
    float t = fract(aSeed + uTime * aSpeed * 0.045);

    float x = mix(-1.3, 1.3, t) * uAspect;
    float y = aLane * 0.62 + sin(t * 6.2831 + aSeed * 11.0) * 0.07;

    // Fade at both ends so packets never pop in or out mid-flight.
    vAlpha = smoothstep(0.0, 0.13, t) * (1.0 - smoothstep(0.85, 1.0, t));
    vTone = aSeed;

    vec2 pos = vec2(x, y) * (1.0 + uProgress * 0.55);
    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = aSize * uDpr * (1.0 + uProgress * 0.9);
  }
`;

export const packetFragment = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying float vTone;

  void main() {
    float r = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.05, r) * vAlpha;
    vec3 c = mix(vec3(0.188, 0.369, 1.0), vec3(0.478, 0.353, 0.973), vTone);
    gl_FragColor = vec4(c, a * 0.7);
  }
`;
