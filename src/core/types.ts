export type SpeakerId = 'A' | 'B' | 'M' | 'W' | 'S';

export interface AtmosLevels { hum: number; line: number; breath: number; bass: number }

/** Visual + sonic state of a dramatic beat. All values 0..1. */
export interface SceneDef {
  stress: number;   // tremor, stroke chaos
  red: number;      // aggression of the red
  decay: number;    // how destroyed the call UI is (scratches, scribbles)
  clean: number;    // how much clutter has been wiped from the screen
  dead: number;     // how lifeless the call looks
  atmos: AtmosLevels;
}

export interface LayerDef { pitchMedian: number; formant: number; delay: number; pan: number; gainDb: number }

export interface FxDef {
  draw?: string;
  shake?: number;
  red?: number;
  flash?: number;
  scratch?: number;
  ghosts?: number;
  spin?: number;
}

export interface LineDef {
  id: string;
  scene: string;
  speaker: SpeakerId;
  kind?: 'speech' | 'sfx';
  mood: string;
  en: string;
  speak?: string;
  ua: string;
  sfx?: string;
  tts?: Record<string, unknown>;
  dsp?: Record<string, unknown>;
  timing?: { gapBefore?: number; overlap?: number };
  layers?: LayerDef[];
  fx?: FxDef;
}

export interface IntroDef {
  blackSeconds: number;
  ringCount: number;
  ringSeconds: number;
  ringGapSeconds: number;
  autoAnswerAfterRings: number;
  connectSeconds: number;
  label: string;
}

export interface OutroDef { holdSeconds: number; lineDropSeconds: number; blackSeconds: number }

export interface Scenario {
  meta: { title: string; version: number; notes?: string };
  intro: IntroDef;
  outro: OutroDef;
  moods: Record<string, { speed: number; classTemperature: number; dsp: string; dyn?: [number, number] }>;
  dspPresets: Record<string, Record<string, number | boolean>>;
  scenes: Record<string, SceneDef>;
  lines: LineDef[];
}

export interface WordTiming { w: string; t0: number; t1: number }

export interface ManifestLine {
  file: string;
  duration: number;
  layers: { file: string; delay: number; pan: number; gainDb: number }[];
  words: WordTiming[];
  alignment: string;
  /** 'omnivoice' | 'sapi-draft' (offline stand-in) | 'sfx' */
  engine?: string | null;
}

export interface Manifest { sampleRate: number; lines: Record<string, ManifestLine> }

export interface SubtitleCue {
  text: string;     // already wrapped with \n (max 2 lines)
  start: number;    // call-time seconds
  end: number;      // call-time seconds (end of the words, before the linger)
  hide: number;     // when the cue is fully gone
}

export interface TimelineLine {
  id: string;
  index: number;
  speaker: SpeakerId;
  mood: string;
  scene: string;
  start: number;
  end: number;
  duration: number;
  en: string;
  ua: string;
  file: string;
  layers: { file: string; delay: number; pan: number; gainDb: number }[];
  words: WordTiming[];
  fx: FxDef;
  kind: 'speech' | 'sfx';
  engine: string;
}

export interface Timeline {
  connectSeconds: number;
  speechStart: number;
  speechEnd: number;
  /** end of the conversation + outro hold (call time) */
  callEnd: number;
  lineDropAt: number;
  duration: number;       // call time until the final black
  lines: TimelineLine[];
}

export interface SceneParams extends SceneDef {
  shake: number;
  flash: number;
  ghosts: number;
  spin: number;
  scratchBoost: number;
}
