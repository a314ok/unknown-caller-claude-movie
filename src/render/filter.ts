import { Filter, GlProgram } from 'pixi.js';

const vertex = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}
void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}`;

/**
 * Oil-pastel-on-black-paper finish. Deliberately NOT a glitch/VHS pass: no RGB split, no scanlines.
 *  - wax grain: streaky tooth that breaks the strokes up where the crayon skips the paper
 *  - black paper speckle + analog film noise
 *  - the red breathes (heartbeat pulse in the corners) and spikes on `flash`
 *  - `dead` drains the picture towards a lifeless grey
 */
const fragment = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec2 uRes;
uniform float uTime;
uniform float uFrame;
uniform float uGrain;
uniform float uNoise;
uniform float uRed;
uniform float uFlash;
uniform float uDead;
uniform float uWobble;
uniform float uBeat;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main(void) {
  vec2 uv = vTextureCoord;
  vec2 px = uv * uRes;
  float fr = uFrame;

  // the paper itself breathes a little between redraws
  vec2 w = vec2(vnoise(uv * 4.0 + fr * 0.37), vnoise(uv * 4.0 + 17.0 + fr * 0.53)) - 0.5;
  uv += w * (0.0012 + uWobble * 0.0035);

  vec3 col = texture(uTexture, uv).rgb;
  float L = dot(col, vec3(0.3333));

  // wax grain: streaks along the stroke direction + speckle where the pigment skips
  float streak = vnoise(vec2(px.x * 0.30, px.y * 0.07) + fr * 1.9);
  float streak2 = vnoise(vec2(px.x * 0.06, px.y * 0.33) - fr * 1.3);
  float speck = hash(floor(px / 1.6) + fr * 7.13);
  float tooth = clamp(0.5 * streak + 0.35 * streak2 + 0.5 * speck, 0.0, 1.0);
  float cut = smoothstep(0.22, 0.68, tooth);
  float ink = smoothstep(0.02, 0.35, L);
  col *= mix(1.0, mix(0.28, 1.0, cut), uGrain * ink);

  // black-paper tooth: faint pale fibres on the dark
  float fibre = hash(floor(px / 2.0) + 3.0 * fr);
  col += vec3(0.9, 0.88, 0.84) * smoothstep(0.93, 1.0, fibre) * 0.05 * (1.0 - ink);

  // analog film noise
  col += (hash(px + uTime * 61.0) - 0.5) * uNoise;

  // vignette + red heartbeat breathing from the edges
  vec2 d = (vTextureCoord - 0.5) * vec2(1.0, 0.85);
  float vig = smoothstep(0.28, 0.82, length(d));
  float pulse = 0.55 + 0.45 * sin(uTime * (2.2 + uRed * 2.5)) * sin(uTime * 0.7 + 1.0) + uBeat;
  col.r += uRed * (0.10 + 0.5 * vig) * clamp(pulse, 0.0, 1.4) * 0.5;
  col *= 1.0 - vig * (0.50 + 0.2 * uDead);

  // emotional peak: a hot red burst
  col = mix(col, vec3(0.95, 0.06, 0.04), uFlash * (0.25 + 0.35 * vig));
  col += vec3(0.1, 0.0, 0.0) * uFlash;

  // lifeless: drain colour and light
  col = mix(col, vec3(dot(col, vec3(0.3333))) * 0.62, uDead * 0.75);

  finalColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class CrayonFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex, fragment, name: 'crayon-paper' }),
      resources: {
        crayon: {
          uRes: { value: new Float32Array([1920, 1080]), type: 'vec2<f32>' },
          uTime: { value: 0, type: 'f32' },
          uFrame: { value: 0, type: 'f32' },
          uGrain: { value: 0.85, type: 'f32' },
          uNoise: { value: 0.05, type: 'f32' },
          uRed: { value: 0, type: 'f32' },
          uFlash: { value: 0, type: 'f32' },
          uDead: { value: 0, type: 'f32' },
          uWobble: { value: 0, type: 'f32' },
          uBeat: { value: 0, type: 'f32' },
        },
      },
    });
  }

  private get u() { return this.resources.crayon.uniforms as Record<string, number | Float32Array>; }

  set(values: Partial<Record<'uTime' | 'uFrame' | 'uGrain' | 'uNoise' | 'uRed' | 'uFlash' | 'uDead' | 'uWobble' | 'uBeat', number>>) {
    Object.assign(this.u, values);
  }

  setResolution(w: number, h: number) {
    const r = this.u.uRes as Float32Array;
    r[0] = w; r[1] = h;
  }
}
