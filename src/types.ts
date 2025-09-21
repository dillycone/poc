export interface VideoTimestamps {
  start_time: string;
  end_time: string;
}

export interface GameContext {
  quarter: number;
  game_clock?: string | null; // changed to optional | null to match observed data
  offense_team: string;
  defense_team: string;
  offense_score: number;
  defense_score: number;
}

export interface Situation {
  down: 1 | 2 | 3 | 4;
  distance: number;
  yard_line: string;
  hash_mark?: "Left" | "Middle" | "Right";
}

export interface Motion {
  player_jersey?: number;
  motion_type?: "Jet" | "Orbit" | "Shift" | "Across";
  motion_direction?: "Left to Right" | "Right to Left";
}

export interface OffensePreSnap {
  personnel?: string;
  formation?: "Shotgun" | "Pistol" | "I-Formation" | "Singleback" | "Empty" | "Wildcat" | "Under Center";
  backfield_set?: string;
  strength?: "Left" | "Right" | "Balanced";
  motion?: Motion;
}

export interface DefensePreSnap {
  front?: "4-3" | "3-4" | "4-2-5" | "3-3-5" | "Bear" | "Okie";
  players_in_box?: number;
  coverage_shell?: "Cover 0" | "Cover 1" | "Cover 2" | "Cover 3" | "Cover 4" | "Cover 6" | "Man";
}

export interface PreSnap {
  offense?: OffensePreSnap;
  defense?: DefensePreSnap;
}

export interface RunDetails {
  concept?: "Inside Zone" | "Outside Zone" | "Power" | "Counter" | "Sweep" | "Draw" | "Toss" | "Trap" | "QB Keep";
  ball_carrier_jersey?: number;
  direction?: string;
}

export interface PassDetails {
  concept?: string;
  protection?: "Slide" | "Man" | "Play Action" | "Rollout" | "Sprint Out" | "Quick";
  qb_jersey?: number;
  intended_receiver_jersey?: number;
  pass_type?: "Screen" | "Quick Pass" | "Dropback";
}

export interface Play {
  play_type: "Run" | "Pass" | "Punt" | "Field Goal" | "Kickoff" | "Special";
  run_details?: RunDetails;
  pass_details?: PassDetails;
}

export interface Turnover {
  type?: "Fumble" | "Interception";
  forced_by_jersey?: number;
  recovered_by_jersey?: number;
}

export interface Penalty {
  flag_thrown?: boolean;
  team?: string;
  infraction?: string;
  enforcement?: "Accepted" | "Declined" | "Offsetting";
}

export interface ScoringPlay {
  is_score?: boolean;
  type?: "Touchdown" | "Field Goal" | "Safety" | "Extra Point";
  player_jersey?: number;
}

export interface Result {
  outcome: string;
  yards_gained: number;
  tacklers_jersey?: number[];
  turnover?: Turnover;
  penalty?: Penalty;
  scoring_play?: ScoringPlay;
}

export interface FootballPlay {
  play_id: string;
  video_timestamps: VideoTimestamps;
  game_context: GameContext;
  situation: Situation;
  pre_snap: PreSnap;
  play: Play;
  result: Result;
}

export interface FootballAnalysis {
  plays: FootballPlay[];
}

/* === Multipass types for three-pass pipeline === */
export type PassId = 'pass1' | 'pass2' | 'pass3';

export interface PlayMarker {
  play_id: string;
  start_time: string; // HH:MM:SS
  end_time: string;   // HH:MM:SS
  quarter?: number | null;
  game_clock?: string | null;
  offense_team?: string;
  defense_team?: string;
  notes?: string;
  confidence?: number; // 0..1
}

export interface Pass1Overview {
  plays: PlayMarker[];
  video_uri: string;
}

export interface FieldConfidence {
  path: string;       // dot-path into FootballPlay (e.g., "play.pass_details.concept")
  value: any;
  confidence: number; // 0..1
  source: PassId;
  rationale?: string;
}

export interface Pass2PlayAnalysis {
  play_id: string;
  analysis: FootballPlay;      // normalized full play object
  fieldConfidences?: FieldConfidence[];
}

export interface VerificationChange {
  path: string;   // dot path
  from?: any;
  to?: any;
  reason?: string;
  confidence?: number; // 0..1
}

export interface Pass3Verification {
  play_id: string;
  issues: string[];
  changes: VerificationChange[];
}

export interface MultiPassArtifacts {
  pass1: Pass1Overview;
  pass2: Pass2PlayAnalysis[];
  pass3: Pass3Verification[];
}

/* === Rate Limiting Configuration === */
export interface RateLimitConfig {
  delayBetweenRequests?: number; // ms between successful API calls in pass2
  maxRetries?: number;           // retry attempts on retriable errors
  baseDelayMs?: number;          // base backoff delay in ms
  jitterMs?: number;             // +/- jitter added to each backoff delay
}

export interface AggregationOptions {
  prefer?: PassId[]; // priority order, e.g. ['pass3','pass2','pass1']
  thresholds?: {
    accept: number;   // accept value if >= accept (for future use if applying field-level confidences)
    override: number; // pass3 can override if >= override
  };
  rateLimit?: RateLimitConfig; // optional rate limit config for pass2 processing
}