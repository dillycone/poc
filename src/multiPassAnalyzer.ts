import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync } from 'fs';
import {
  FootballAnalysis,
  FootballPlay,
  Pass1Overview,
  Pass2PlayAnalysis,
  Pass3Verification,
  MultiPassArtifacts,
  AggregationOptions,
  RateLimitConfig,
  PlayMarker
} from './types';

type GenModel = ReturnType<GoogleGenerativeAI['getGenerativeModel']>;

function save(name: string, data: unknown) {
  writeFileSync(name, JSON.stringify(data, null, 2), 'utf8');
}

/* === Structured Output Schemas === */
const PASS1_SCHEMA: any = {
  type: 'object',
  properties: {
    plays: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          play_id: { type: 'string' },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          quarter: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          game_clock: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          offense_team: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          defense_team: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'number' },
          notes: { anyOf: [{ type: 'string' }, { type: 'null' }] }
        },
        required: ['play_id', 'start_time', 'end_time'],
        additionalProperties: false
      }
    },
    video_uri: { type: 'string' }
  },
  required: ['plays', 'video_uri'],
  additionalProperties: false
};

const PASS2_SCHEMA: any = {
  type: 'object',
  properties: {
    play_id: { type: 'string' },
    video_timestamps: {
      type: 'object',
      properties: {
        start_time: { type: 'string' },
        end_time: { type: 'string' }
      },
      required: ['start_time', 'end_time'],
      additionalProperties: false
    },
    game_context: {
      type: 'object',
      properties: {
        quarter: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        game_clock: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        offense_team: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        defense_team: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        offense_score: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        defense_score: { anyOf: [{ type: 'number' }, { type: 'null' }] }
      },
      required: ['quarter', 'game_clock', 'offense_team', 'defense_team'],
      additionalProperties: false
    },
    situation: {
      type: 'object',
      properties: {
        down: { anyOf: [{ type: 'integer', minimum: 1, maximum: 4 }, { type: 'null' }] },
        distance: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        yard_line: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        hash_mark: {
          anyOf: [
            { type: 'string', enum: ['Left', 'Middle', 'Right'] },
            { type: 'null' }
          ]
        }
      },
      additionalProperties: false
    },
    pre_snap: {
      type: 'object',
      properties: {
        offense: {
          type: 'object',
          properties: {
            personnel: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            formation: {
              anyOf: [
                { type: 'string', enum: ['Shotgun', 'Pistol', 'I-Formation', 'Singleback', 'Empty', 'Wildcat', 'Under Center'] },
                { type: 'null' }
              ]
            },
            backfield_set: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            strength: {
              anyOf: [
                { type: 'string', enum: ['Left', 'Right', 'Balanced'] },
                { type: 'null' }
              ]
            }
          },
          additionalProperties: false
        },
        defense: {
          type: 'object',
          properties: {
            front: {
              anyOf: [
                { type: 'string', enum: ['4-3', '3-4', '4-2-5', '3-3-5', 'Bear', 'Okie'] },
                { type: 'null' }
              ]
            },
            players_in_box: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            coverage_shell: {
              anyOf: [
                { type: 'string', enum: ['Cover 0', 'Cover 1', 'Cover 2', 'Cover 3', 'Cover 4', 'Cover 6', 'Man'] },
                { type: 'null' }
              ]
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    play: {
      type: 'object',
      properties: {
        play_type: { type: 'string', enum: ['Run', 'Pass', 'Punt', 'Field Goal', 'Kickoff', 'Special'] },
        run_details: {
          anyOf: [
            {
              type: 'object',
              properties: {
                concept: {
                  anyOf: [
                    { type: 'string', enum: ['Inside Zone', 'Outside Zone', 'Power', 'Counter', 'Sweep', 'Draw', 'Toss', 'Trap', 'QB Keep'] },
                    { type: 'null' }
                  ]
                },
                ball_carrier_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                direction: { anyOf: [{ type: 'string' }, { type: 'null' }] }
              },
              additionalProperties: false
            },
            { type: 'null' }
          ]
        },
        pass_details: {
          anyOf: [
            {
              type: 'object',
              properties: {
                concept: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                protection: {
                  anyOf: [
                    { type: 'string', enum: ['Slide', 'Man', 'Play Action', 'Rollout', 'Sprint Out', 'Quick'] },
                    { type: 'null' }
                  ]
                },
                qb_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                intended_receiver_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                pass_type: {
                  anyOf: [
                    { type: 'string', enum: ['Screen', 'Quick Pass', 'Dropback'] },
                    { type: 'null' }
                  ]
                }
              },
              additionalProperties: false
            },
            { type: 'null' }
          ]
        }
      },
      required: ['play_type'],
      additionalProperties: false
    },
    result: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        yards_gained: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        tacklers_jersey: {
          anyOf: [
            { type: 'array', items: { type: 'integer' } },
            { type: 'null' }
          ]
        },
        turnover: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: {
                  anyOf: [
                    { type: 'string', enum: ['Fumble', 'Interception'] },
                    { type: 'null' }
                  ]
                },
                forced_by_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                recovered_by_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] }
              },
              additionalProperties: false
            },
            { type: 'null' }
          ]
        },
        penalty: {
          anyOf: [
            {
              type: 'object',
              properties: {
                flag_thrown: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
                team: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                infraction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                enforcement: {
                  anyOf: [
                    { type: 'string', enum: ['Accepted', 'Declined', 'Offsetting'] },
                    { type: 'null' }
                  ]
                }
              },
              additionalProperties: false
            },
            { type: 'null' }
          ]
        },
        scoring_play: {
          anyOf: [
            {
              type: 'object',
              properties: {
                is_score: { type: 'boolean' },
                type: {
                  anyOf: [
                    { type: 'string', enum: ['Touchdown', 'Field Goal', 'Safety', 'Extra Point', 'Two-Point Conversion'] },
                    { type: 'null' }
                  ]
                },
                player_jersey: { anyOf: [{ type: 'integer' }, { type: 'null' }] }
              },
              required: ['is_score'],
              additionalProperties: false
            },
            { type: 'null' }
          ]
        }
      },
      required: ['outcome'],
      additionalProperties: false
    },
    fieldConfidences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          value: {},
          confidence: { type: 'number' },
          source: { type: 'string', enum: ['pass1', 'pass2', 'pass3'] },
          rationale: { anyOf: [{ type: 'string' }, { type: 'null' }] }
        },
        required: ['path', 'confidence', 'source'],
        additionalProperties: false
      }
    }
  },
  required: ['play_id', 'video_timestamps', 'game_context', 'play', 'result'],
  additionalProperties: false
};

function tryParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      .trim()
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      return {};
    }
  }
}

/* === Rate limiting helpers === */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  delayBetweenRequests: 1500,
  maxRetries: 5,
  baseDelayMs: 1000,
  jitterMs: 250
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStatusCode(err: any): number | undefined {
  if (typeof err?.status === 'number') return err.status;
  const msg: string | undefined = err?.message;
  if (typeof msg === 'string') {
    const m = msg.match(/\[(\d{3})\s/);
    if (m) return Number(m[1]);
    const m2 = msg.match(/\b(429|503)\b/);
    if (m2) return Number(m2[1]);
  }
  return undefined;
}

function isRetriableError(err: any): boolean {
  const code = getStatusCode(err);
  return code === 429 || code === 503;
}

function calcBackoffDelay(attempt: number, cfg: RateLimitConfig): number {
  const base = Math.max(0, cfg.baseDelayMs ?? 1000);
  const jitter = cfg.jitterMs ?? 0;
  const delay = base * Math.pow(2, attempt);
  const j = jitter ? Math.floor((Math.random() * 2 - 1) * jitter) : 0;
  return delay + j;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  cfg: RateLimitConfig,
  label?: string
): Promise<T> {
  const maxRetries = cfg.maxRetries ?? 5;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const retriable = isRetriableError(err);
      if (!retriable || i === maxRetries) {
        console.error(`Retry exhausted or non-retriable error${label ? ` for ${label}` : ''}:`, err?.message || err);
        throw err;
      }
      const wait = calcBackoffDelay(i, cfg);
      console.warn(`Retry ${i + 1}/${maxRetries} (${getStatusCode(err)})${label ? ` for ${label}` : ''}; waiting ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error('retryWithBackoff: exhausted unexpectedly');
}

/* === Time utilities === */
function safePart(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function timeToSeconds(s: string): number {
  if (!s) return 0;
  const parts = s.split(':').map(n => Number.parseInt(n, 10));
  if (parts.length === 3) {
    const [h = 0, m = 0, sec = 0] = parts;
    return safePart(h) * 3600 + safePart(m) * 60 + safePart(sec);
  }
  if (parts.length === 2) {
    const [m = 0, sec = 0] = parts;
    return safePart(m) * 60 + safePart(sec);
  }
  const [only = 0] = parts;
  return safePart(only);
}

function hhmmssToSec(s: string): number {
  if (!s) return 0;
  const parts = s.split(':').map(n => Number.parseInt(n, 10));
  if (parts.length === 3) {
    const [h = 0, m = 0, sec = 0] = parts;
    return safePart(h) * 3600 + safePart(m) * 60 + safePart(sec);
  }
  if (parts.length === 2) {
    const [m = 0, sec = 0] = parts;
    return safePart(m) * 60 + safePart(sec);
  }
  const [only = 0] = parts;
  return safePart(only);
}

function byStart(a: { start_time: string }, b: { start_time: string }) {
  return timeToSeconds(a.start_time) - timeToSeconds(b.start_time);
}

function secondsToHHMMSS(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const hh = hours.toString().padStart(2, '0');
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function sanitizePlayMarkers(rawMarkers: unknown[]): PlayMarker[] {
  const markers: Array<{ raw: any; start: number; end: number }> = rawMarkers
    .filter(value => value && typeof value === 'object')
    .map((value: any) => {
      const start = timeToSeconds(String(value.start_time ?? ''));
      const end = timeToSeconds(String(value.end_time ?? ''));
      return { raw: value, start, end };
    });

  markers.sort((a, b) => a.start - b.start);

  const sanitized: PlayMarker[] = [];
  const seenIds = new Set<string>();
  let fallbackCounter = 1;
  let previousEnd = 0;
  const MIN_SEGMENT = 2; // seconds

  for (const marker of markers) {
    let start = Number.isFinite(marker.start) ? Math.max(0, Math.floor(marker.start)) : previousEnd;
    let end = Number.isFinite(marker.end) ? Math.max(0, Math.floor(marker.end)) : start + MIN_SEGMENT;

    if (start < previousEnd) {
      start = previousEnd;
    }

    if (end <= start) {
      end = start + MIN_SEGMENT;
    }

    const rawId = typeof marker.raw.play_id === 'string' && marker.raw.play_id.trim().length > 0
      ? marker.raw.play_id.trim()
      : `PLAY_${fallbackCounter}`;

    let candidateId = rawId;
    let suffix = 1;
    while (seenIds.has(candidateId)) {
      candidateId = `${rawId}_${suffix}`;
      suffix += 1;
    }
    seenIds.add(candidateId);
    fallbackCounter += 1;

    const rawQuarter = marker.raw.quarter;
    const quarter = typeof rawQuarter === 'number' && Number.isFinite(rawQuarter)
      ? Math.max(0, Math.min(4, Math.trunc(rawQuarter)))
      : null;

    const rawClock = typeof marker.raw.game_clock === 'string' ? marker.raw.game_clock.trim() : null;
    const offense = typeof marker.raw.offense_team === 'string' ? marker.raw.offense_team.trim() : undefined;
    const defense = typeof marker.raw.defense_team === 'string' ? marker.raw.defense_team.trim() : undefined;
    const notes = typeof marker.raw.notes === 'string' ? marker.raw.notes : undefined;
    const confidence = typeof marker.raw.confidence === 'number' && Number.isFinite(marker.raw.confidence)
      ? Math.min(1, Math.max(0, marker.raw.confidence))
      : null;

    const sanitizedMarker: PlayMarker = {
      play_id: candidateId,
      start_time: secondsToHHMMSS(start),
      end_time: secondsToHHMMSS(Math.max(end, start + MIN_SEGMENT)),
      quarter,
      game_clock: rawClock && rawClock.length > 0 ? rawClock : null
    };

    if (offense && offense.length > 0) {
      sanitizedMarker.offense_team = offense;
    }
    if (defense && defense.length > 0) {
      sanitizedMarker.defense_team = defense;
    }
    if (notes) {
      sanitizedMarker.notes = notes;
    }
    if (confidence !== null) {
      sanitizedMarker.confidence = confidence;
    }

    sanitized.push(sanitizedMarker);
    previousEnd = timeToSeconds(sanitizedMarker.end_time);
  }

  return sanitized;
}

/* === Model factory === */
function getModel(apiKey: string, modelName: string = 'gemini-2.5-pro'): GenModel {
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });
}

/* === Content builders for GenAI API === */
function makeVideoPart(videoUri: string, startSec?: number, endSec?: number, fps: number = 1): any {
  const part: any = {
    fileData: { fileUri: videoUri, mimeType: 'video/*' }
  };
  if (
    typeof startSec === 'number' &&
    typeof endSec === 'number' &&
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    endSec > startSec
  ) {
    part.videoMetadata = {
      startOffset: `${Math.max(0, Math.floor(startSec))}s`,
      endOffset: `${Math.max(0, Math.floor(endSec))}s`,
      fps
    };
  }
  return part;
}

function makeTextPart(text: string): any {
  return { text };
}

function makeUserContent(parts: any[]): any {
  return { role: 'user', parts };
}

/* === Helper to robustly extract text from GenAI responses === */
async function readResponseText(genResult: any): Promise<string> {
  try {
    const resp = await genResult?.response;
    if (resp && typeof resp.text === 'function') {
      const t = resp.text();
      return typeof t === 'string' ? t : String(t);
    }
    // fallback: some SDK variants may expose text directly
    if (typeof genResult?.text === 'function') {
      const t2 = genResult.text();
      return typeof t2 === 'string' ? t2 : String(t2);
    }
    return JSON.stringify(resp ?? genResult ?? '');
  } catch {
    return '';
  }
}

/* === Pass 1: detect plays + coarse metadata === */
export async function runPass1Overview(model: GenModel, videoUri: string): Promise<Pass1Overview> {
  const prompt = `
You are a football video segmenter. Identify all discrete plays with timestamps.

Return JSON:
{
  "plays": [
    {
      "play_id": "GAME1_PLAY_#",
      "start_time": "HH:MM:SS",
      "end_time": "HH:MM:SS",
      "quarter": number | null,
      "game_clock": "MM:SS" | null,
      "offense_team": string | null,
      "defense_team": string | null,
      "confidence": number
    }
  ],
  "video_uri": string
}

Rules:
- Use sequential play_ids with no gaps.
- Skip replays, timeouts, penalties without a snap.
- If unsure, use null and lower confidence.
`;

  const request = {
    contents: [
      makeUserContent([
        makeVideoPart(videoUri),
        makeTextPart(prompt)
      ])
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PASS1_SCHEMA
    }
  } as any;

  const genResult = await retryWithBackoff(
    () => model.generateContent(request),
    DEFAULT_RATE_LIMIT,
    'Pass1'
  );

  const text = await readResponseText(genResult);
  const json = tryParseJSON(text) || {};
  const rawPlays = Array.isArray(json.plays) ? json.plays : [];
  const plays = sanitizePlayMarkers(rawPlays);

  const overview: Pass1Overview = { plays, video_uri: videoUri };
  return overview;
}

/* === Pass 2: per-play deep analysis (serial with delay/backoff + partial saves) === */
export async function runPass2Detailed(
  model: GenModel,
  videoUri: string,
  p1: Pass1Overview,
  rateLimit?: RateLimitConfig
): Promise<Pass2PlayAnalysis[]> {
  const out: Pass2PlayAnalysis[] = [];
  const cfg: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, ...(rateLimit || {}) };

  for (let idx = 0; idx < p1.plays.length; idx++) {
    const marker = p1.plays[idx];
    if (!marker) {
      // Safety under noUncheckedIndexedAccess
      continue;
    }

    // Fixed inter-request delay with jitter (skip before first)
    if (idx > 0 && (cfg.delayBetweenRequests ?? 0) > 0) {
      const base = cfg.delayBetweenRequests ?? 0;
      const j = cfg.jitterMs ? Math.floor((Math.random() * 2 - 1) * cfg.jitterMs) : 0;
      const waitMs = base + j;
      if (waitMs > 0) await sleep(waitMs);
    }

    const prompt = `
Analyze ONLY the segment ${marker.start_time} to ${marker.end_time}.

Return JSON strictly matching:
{
  "play_id": "string",
  "video_timestamps": { "start_time": "HH:MM:SS", "end_time": "HH:MM:SS" },
  "game_context": {
    "quarter": number | null,
    "game_clock": "MM:SS" | null,
    "offense_team": string | null,
    "defense_team": string | null,
    "offense_score": number | null,
    "defense_score": number | null
  },
  "situation": {
    "down": 1|2|3|4 | null,
    "distance": number | null,
    "yard_line": string | null,
    "hash_mark": "Left" | "Middle" | "Right" | null
  },
  "pre_snap": {
    "offense": {
      "personnel": string | null,
      "formation": "Shotgun"|"Pistol"|"I-Formation"|"Singleback"|"Empty"|"Wildcat"|"Under Center" | null,
      "backfield_set": string | null,
      "strength": "Left"|"Right"|"Balanced" | null
    },
    "defense": {
      "front": "4-3"|"3-4"|"4-2-5"|"3-3-5"|"Bear"|"Okie" | null,
      "players_in_box": number | null,
      "coverage_shell": "Cover 0"|"Cover 1"|"Cover 2"|"Cover 3"|"Cover 4"|"Cover 6"|"Man" | null
    }
  },
  "play": {
    "play_type": "Run"|"Pass"|"Punt"|"Field Goal"|"Kickoff"|"Special",
    "run_details": {
      "concept": "Inside Zone"|"Outside Zone"|"Power"|"Counter"|"Sweep"|"Draw"|"Toss"|"Trap"|"QB Keep" | null,
      "ball_carrier_jersey": number | null,
      "direction": string | null
    } | null,
    "pass_details": {
      "concept": string | null,
      "protection": "Slide"|"Man"|"Play Action"|"Rollout"|"Sprint Out"|"Quick" | null,
      "qb_jersey": number | null,
      "intended_receiver_jersey": number | null,
      "pass_type": "Screen"|"Quick Pass"|"Dropback" | null
    } | null
  },
  "result": {
    "outcome": string,
    "yards_gained": number | null,
    "tacklers_jersey": number[] | null,
    "turnover": { "type": "Fumble"|"Interception" | null } | null,
    "penalty": { "flag_thrown": boolean } | null,
    "scoring_play": { "is_score": boolean, "type": "Touchdown"|"Field Goal"|"Safety"|"Extra Point"|"Two-Point Conversion" | null, "player_jersey": number | null } | null
  },
  "fieldConfidences": [
    { "path": "play.pass_details.concept", "value": "...", "confidence": 0.78, "source": "pass2", "rationale": "why" }
  ]
}

Be conservative; set null for unknowns.
`;

    const startS = hhmmssToSec(marker.start_time);
    const endS = hhmmssToSec(marker.end_time);
    if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
      console.warn(`Skipping invalid segment for ${marker.play_id}: ${marker.start_time}–${marker.end_time}`);
      continue;
    }

    const request = {
      contents: [
        makeUserContent([
          makeVideoPart(videoUri, startS, endS, 1),
          makeTextPart(prompt)
        ])
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: PASS2_SCHEMA
      }
    } as any;

    const genResult = await retryWithBackoff(
      () => model.generateContent(request),
      cfg,
      `Pass2 ${marker.play_id}`
    );

    const text = await readResponseText(genResult);
    const json = tryParseJSON(text) || {};

    // Safe guards for nested objects that may be missing
    const gc: any = (json && typeof json === 'object' && json.game_context && typeof json.game_context === 'object')
      ? json.game_context
      : {};
    const sit: any = (json && typeof json === 'object' && json.situation && typeof json.situation === 'object')
      ? json.situation
      : null;
    const pre: any = (json && typeof json === 'object' && json.pre_snap && typeof json.pre_snap === 'object')
      ? json.pre_snap
      : null;
    const pl: any = (json && typeof json === 'object' && json.play && typeof json.play === 'object')
      ? json.play
      : null;
    const res: any = (json && typeof json === 'object' && json.result && typeof json.result === 'object')
      ? json.result
      : null;

    // Fallbacks from pass1 marker with safe narrowing
    const fallbackQuarter = typeof marker.quarter === 'number' ? marker.quarter : 0;
    const fallbackClock = typeof marker.game_clock === 'string' ? marker.game_clock : null;
    const fallbackOffense = typeof marker.offense_team === 'string' ? marker.offense_team : '';
    const fallbackDefense = typeof marker.defense_team === 'string' ? marker.defense_team : '';

    const play: FootballPlay = {
      play_id: (json && typeof json === 'object' && typeof (json as any).play_id === 'string')
        ? (json as any).play_id
        : marker.play_id,
      video_timestamps: {
        start_time: marker.start_time,
        end_time: marker.end_time
      },
      game_context: {
        quarter: (gc && typeof gc.quarter === 'number') ? gc.quarter : fallbackQuarter,
        game_clock: (gc && (typeof gc.game_clock === 'string' || gc.game_clock === null)) ? gc.game_clock : fallbackClock,
        offense_team: (gc && typeof gc.offense_team === 'string') ? gc.offense_team : fallbackOffense,
        defense_team: (gc && typeof gc.defense_team === 'string') ? gc.defense_team : fallbackDefense,
        offense_score: (gc && typeof gc.offense_score === 'number') ? gc.offense_score : 0,
        defense_score: (gc && typeof gc.defense_score === 'number') ? gc.defense_score : 0
      },
      situation: sit || { down: 1, distance: 10, yard_line: 'OWN 25' },
      pre_snap: pre || {},
      play: pl || { play_type: 'Special' },
      result: res || { outcome: '', yards_gained: 0 }
    };

    out.push({
      play_id: play.play_id,
      analysis: play,
      fieldConfidences: Array.isArray((json as any).fieldConfidences) ? (json as any).fieldConfidences : []
    });

    // Save partial results after each play to aid resume/debugging
    try {
      save('pass2_detailed.json', out);
    } catch (e) {
      console.warn('Failed to save partial pass2_detailed.json:', e);
    }
  }

  return out;
}

/* === Pass 3: verify and suggest overrides for critical fields (with retry) === */
export async function runPass3Verification(model: GenModel, videoUri: string, p2: Pass2PlayAnalysis[]): Promise<Pass3Verification[]> {
  const compact = p2.map(x => ({
    play_id: x.play_id,
    start: x.analysis.video_timestamps.start_time,
    end: x.analysis.video_timestamps.end_time,
    quarter: x.analysis.game_context.quarter,
    clock: x.analysis.game_context.game_clock,
    offense_team: x.analysis.game_context.offense_team,
    defense_team: x.analysis.game_context.defense_team,
    play_type: x.analysis.play.play_type,
    yards_gained: x.analysis.result.yards_gained,
    scoring_play: x.analysis.result.scoring_play,
    turnover: x.analysis.result.turnover
  }));

  const prompt = `
You are a verifier. Input is a compact list of analyzed plays.
Tasks:
- Validate scoring plays and turnovers.
- Spot inconsistent quarter/clock ranges or implausible yards vs down-distance.
- Suggest changes you are confident in.

Return JSON:
[
  {
    "play_id": "string",
    "issues": ["string", ...],
    "changes": [
      { "path": "result.scoring_play.type", "from": "Touchdown", "to": null, "reason": "Replay misread", "confidence": 0.8 }
    ]
  }
]
Only include changes with confidence >= 0.6.
`;

  const request = {
    contents: [
      makeUserContent([
        makeVideoPart(videoUri),
        makeTextPart('COMPACT_INPUT:\n' + JSON.stringify(compact, null, 2)),
        makeTextPart(prompt)
      ])
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  } as any;

  const genResult = await retryWithBackoff(
    () => model.generateContent(request),
    DEFAULT_RATE_LIMIT,
    'Pass3'
  );

  const text = await readResponseText(genResult);
  const parsed = tryParseJSON(text);
  const verifications: Pass3Verification[] = Array.isArray(parsed) ? parsed : [];
  return verifications;
}

/* === Helpers for aggregation === */
function setDeep(obj: any, path: string, value: any) {
  const parts = path.split('.').filter(Boolean);
  let curr: any = obj;
  for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
    const key = parts[i]!;
    if (typeof curr !== 'object' || curr === null) break;
    if (!(key in curr) || typeof (curr as any)[key] !== 'object' || (curr as any)[key] === null) {
      (curr as any)[key] = {};
    }
    curr = (curr as any)[key];
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey != null) {
    (curr as any)[lastKey] = value;
  }
}

function applyVerification(play: FootballPlay, ver: Pass3Verification, options?: AggregationOptions) {
  const override = options?.thresholds?.override ?? 0.7;
  for (const ch of ver.changes || []) {
    if ((ch.confidence ?? 0) >= override) {
      setDeep(play, ch.path, ch.to);
    }
  }
}

/* === Aggregation === */
export function aggregateResults(
  p1: Pass1Overview,
  p2: Pass2PlayAnalysis[],
  p3: Pass3Verification[],
  options?: AggregationOptions
): FootballAnalysis {
  const verMap = new Map<string, Pass3Verification>();
  for (const v of p3) verMap.set(v.play_id, v);

  const plays: FootballPlay[] = p2.map(a => {
    const marker = p1.plays.find(m => m.play_id === a.play_id);
    const merged: FootballPlay = {
      ...a.analysis,
      video_timestamps: {
        start_time: marker?.start_time || a.analysis.video_timestamps.start_time,
        end_time: marker?.end_time || a.analysis.video_timestamps.end_time
      }
    };
    const v = verMap.get(a.play_id);
    if (v) applyVerification(merged, v, options);
    return merged;
  });

  plays.sort((x, y) => timeToSeconds(x.video_timestamps.start_time) - timeToSeconds(y.video_timestamps.start_time));
  return { plays };
}

/* === Orchestrator === */
export async function runMultiPass(
  videoUri: string,
  apiKey: string,
  aggOptions?: AggregationOptions,
  modelName?: string
): Promise<{ analysis: FootballAnalysis; artifacts: MultiPassArtifacts }> {
  const model = getModel(apiKey, modelName);

  const pass1 = await runPass1Overview(model, videoUri);
  save('pass1_overview.json', pass1);

  const pass2 = await runPass2Detailed(model, videoUri, pass1, aggOptions?.rateLimit);
  // Final save (in addition to incremental saves for robustness)
  save('pass2_detailed.json', pass2);

  const pass3 = await runPass3Verification(model, videoUri, pass2);
  save('pass3_verification.json', pass3);

  const analysis = aggregateResults(pass1, pass2, pass3, aggOptions);
  return { analysis, artifacts: { pass1, pass2, pass3 } };
}