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
  RateLimitConfig
} from './types';

type GenModel = ReturnType<GoogleGenerativeAI['getGenerativeModel']>;

function save(name: string, data: any) {
  writeFileSync(name, JSON.stringify(data, null, 2), 'utf8');
}

function tryParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      .trim()
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '');
    return JSON.parse(cleaned);
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
function timeToSeconds(s: string): number {
  if (!s) return 0;
  const parts = s.split(':').map(n => parseInt(n, 10));
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return Number.isFinite(parts[0]) ? (parts[0] || 0) : 0;
}
function byStart(a: { start_time: string }, b: { start_time: string }) {
  return timeToSeconds(a.start_time) - timeToSeconds(b.start_time);
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

  const result = await retryWithBackoff(
    () =>
      model.generateContent([
        { fileData: { fileUri: videoUri, mimeType: 'video/*' } },
        { text: prompt }
      ]),
    DEFAULT_RATE_LIMIT,
    'Pass1'
  );

  const text = (await result.response).text();
  const json = tryParseJSON(text);

  if (Array.isArray(json.plays)) {
    json.plays.sort(byStart);
  }

  const overview: Pass1Overview = { plays: json.plays || [], video_uri: videoUri };
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
    "scoring_play": { "is_score": boolean, "type": "Touchdown"|"Field Goal"|"Safety"|"Extra Point" | null, "player_jersey": number | null } | null
  },
  "fieldConfidences": [
    { "path": "play.pass_details.concept", "value": "...", "confidence": 0.78, "source": "pass2", "rationale": "why" }
  ]
}

Be conservative; set null for unknowns.
`;

    const result = await retryWithBackoff(
      () =>
        model.generateContent([
          { fileData: { fileUri: videoUri, mimeType: 'video/*' } },
          { text: prompt }
        ]),
      cfg,
      `Pass2 ${marker.play_id}`
    );

    const text = (await result.response).text();
    const json = tryParseJSON(text);

    const play: FootballPlay = {
      play_id: json.play_id || marker.play_id,
      video_timestamps: {
        start_time: marker.start_time,
        end_time: marker.end_time
      },
      game_context: {
        quarter: json.game_context?.quarter ?? marker.quarter ?? 0,
        game_clock: json.game_context?.game_clock ?? marker.game_clock ?? null,
        offense_team: json.game_context?.offense_team ?? marker.offense_team ?? '',
        defense_team: json.game_context?.defense_team ?? marker.defense_team ?? '',
        offense_score: json.game_context?.offense_score ?? 0,
        defense_score: json.game_context?.defense_score ?? 0
      },
      situation: json.situation || { down: 1, distance: 10, yard_line: 'OWN 25' },
      pre_snap: json.pre_snap || {},
      play: json.play || { play_type: 'Special' },
      result: json.result || { outcome: '', yards_gained: 0 }
    };

    out.push({
      play_id: play.play_id,
      analysis: play,
      fieldConfidences: Array.isArray(json.fieldConfidences) ? json.fieldConfidences : []
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

  const result = await retryWithBackoff(
    () =>
      model.generateContent([
        { fileData: { fileUri: videoUri, mimeType: 'video/*' } },
        { text: "COMPACT_INPUT:\n" + JSON.stringify(compact, null, 2) },
        { text: prompt }
      ]),
    DEFAULT_RATE_LIMIT,
    'Pass3'
  );

  const text = (await result.response).text();
  const verifications: Pass3Verification[] = tryParseJSON(text);
  return verifications;
}

/* === Helpers for aggregation === */
function setDeep(obj: any, path: string, value: any) {
  const parts = path.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!(p in curr) || typeof curr[p] !== 'object' || curr[p] === null) curr[p] = {};
    curr = curr[p];
  }
  curr[parts[parts.length - 1]] = value;
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