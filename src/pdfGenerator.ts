import puppeteer from 'puppeteer';
import type { Browser, LaunchOptions } from 'puppeteer';
import path from 'path';
import { FootballAnalysis, FootballPlay } from './types';

export interface TeamBranding {
  [teamName: string]: {
    primary: string;
    secondary?: string;
    logoUrl?: string; // optional, if you want to include logos in header
  };
}

export interface PDFOptions {
  outputPathDetailed?: string;
  outputPathSummary?: string;
  reportTitle?: string;
  gameDate?: string; // e.g., '2025-09-21' or 'Sep 21, 2025'
  location?: string;
  branding?: TeamBranding;
  includeLogos?: boolean;
}

interface DownStats {
  count: number;
  totalYards: number;
  avgYards: number;
  successKnown: number;
  successes: number;
  successRate: number;
}

interface FormationMix {
  Run: number;
  Pass: number;
  Other: number;
  total: number;
}

interface Stats {
  teamA: string;
  teamB: string;
  teamColors: Record<string, string>;
  score: Record<string, number>;
  totalPlays: number;
  playsByQuarter: Record<number, FootballPlay[]>;
  playTypeCounts: Record<string, number>;
  formationCounts: Record<string, number>;
  formationMix: Record<string, FormationMix>;
  personnelCounts: Record<string, number>;
  downStats: Record<1 | 2 | 3 | 4, DownStats>;
  scoringPlays: Array<{ quarter: number; time: string; team: string; type: string; description: string; points: number }>;
}

const RUN_ROW_COLOR = '#EAF7EE';
const PASS_ROW_COLOR = '#EAF0FF';
const SPECIAL_ROW_COLOR = '#FFF3E0';

function escapeHtml(input: unknown): string {
  const s = String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveColor(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) {
    const d = new Date();
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return escapeHtml(String(dateStr));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  const suffix = s[(v - 20) % 10] ?? s[v] ?? s[0] ?? 'th';
  return `${n}${suffix}`;
}

function deriveScoringTeam(play: FootballPlay): string {
  const outcome = (play.result?.outcome || '').toLowerCase();
  const type = (play.result?.scoring_play?.type || '').toLowerCase();
  if (type.includes('safety')) return play.game_context.defense_team;
  if (outcome.includes('intercept')) return play.game_context.defense_team;
  if (outcome.includes('fumble') && (outcome.includes('return') || outcome.includes('returned'))) {
    return play.game_context.defense_team;
  }
  return play.game_context.offense_team;
}

function pointsForType(t: string | undefined): number {
  if (!t) return 0;
  const type = t.toLowerCase();
  if (type.includes('touchdown')) return 6;
  if (type.includes('field goal')) return 3;
  if (type.includes('safety')) return 2;
  if (type.includes('two-point') || type.includes('two point')) return 2;
  if (type.includes('2-point')) return 2;
  if (type.includes('extra point')) return 1;
  if (type.includes('1-point')) return 1;
  return 0;
}

function summarize(analysis: FootballAnalysis, branding?: TeamBranding): Stats {
  const plays = analysis.plays || [];
  const teamCounts: Record<string, number> = {};
  const score: Record<string, number> = {};
  const playsByQuarter: Record<number, FootballPlay[]> = { 1: [], 2: [], 3: [], 4: [] };
  const playTypeCounts: Record<string, number> = { Run: 0, Pass: 0, Punt: 0, 'Field Goal': 0, Kickoff: 0, Special: 0, Other: 0 };
  const formationCounts: Record<string, number> = {};
  const formationMix: Record<string, FormationMix> = {};
  const personnelCounts: Record<string, number> = {};
  const downStats: Record<1 | 2 | 3 | 4, DownStats> = {
    1: { count: 0, totalYards: 0, avgYards: 0, successKnown: 0, successes: 0, successRate: 0 },
    2: { count: 0, totalYards: 0, avgYards: 0, successKnown: 0, successes: 0, successRate: 0 },
    3: { count: 0, totalYards: 0, avgYards: 0, successKnown: 0, successes: 0, successRate: 0 },
    4: { count: 0, totalYards: 0, avgYards: 0, successKnown: 0, successes: 0, successRate: 0 }
  };
  const scoringPlays: Array<{ quarter: number; time: string; team: string; type: string; description: string; points: number }> = [];

  for (const play of plays) {
    // Teams seen
    const off = play.game_context.offense_team;
    const def = play.game_context.defense_team;
    teamCounts[off] = (teamCounts[off] || 0) + 1;
    teamCounts[def] = (teamCounts[def] || 0) + 1;

    // Scoreboard snapshot
    if (typeof play.game_context.offense_score === 'number') {
      score[off] = play.game_context.offense_score;
    }
    if (typeof play.game_context.defense_score === 'number') {
      score[def] = play.game_context.defense_score;
    }

    // By quarter
    const q = (play.game_context.quarter ?? 0) as number;
    if (!playsByQuarter[q]) {
      playsByQuarter[q] = [];
    }
    (playsByQuarter[q] as FootballPlay[]).push(play);

    // Play type
    const pt = (play.play?.play_type as string) || 'Other';
    if (playTypeCounts[pt] === undefined) playTypeCounts[pt] = 0;
    playTypeCounts[pt]++;

    // Formation + mix
    const form = play.pre_snap?.offense?.formation || 'Unknown';
    formationCounts[form] = (formationCounts[form] || 0) + 1;
    const fm = formationMix[form] ?? (formationMix[form] = { Run: 0, Pass: 0, Other: 0, total: 0 });
    if (pt === 'Run') fm.Run++;
    else if (pt === 'Pass') fm.Pass++;
    else fm.Other++;
    fm.total++;

    // Personnel
    const pers = play.pre_snap?.offense?.personnel || 'Unknown';
    personnelCounts[pers] = (personnelCounts[pers] || 0) + 1;

    // Down stats
    const down = (play.situation?.down as number) || 0;
    const yds = (play.result?.yards_gained as number) ?? 0;
    const dist = play.situation?.distance as number | undefined;
    const ds = down && down >= 1 && down <= 4 ? downStats[down as 1 | 2 | 3 | 4] : undefined;
    if (ds) {
      ds.count++;
      ds.totalYards += (typeof yds === 'number' ? yds : 0);
      if (typeof dist === 'number') {
        ds.successKnown++;
        if ((typeof yds === 'number' ? yds : 0) >= dist) {
          ds.successes++;
        }
      }
    }

    // Scoring summary
    if (play.result?.scoring_play?.is_score) {
      const team = deriveScoringTeam(play);
      const type = play.result.scoring_play?.type || 'Score';
      const desc = play.result.outcome || type;
      const points = pointsForType(play.result.scoring_play?.type);
      const time = play.game_context.game_clock || '';
      scoringPlays.push({
        quarter: q || 0,
        time,
        team,
        type,
        description: desc,
        points
      });
    }
  }

  // Compute averages & rates
  for (const d of [1, 2, 3, 4] as const) {
    const s = downStats[d];
    if (s.count > 0) {
      s.avgYards = +(s.totalYards / s.count).toFixed(2);
    }
    if (s.successKnown > 0) {
      s.successRate = +((s.successes * 100) / s.successKnown).toFixed(1);
    }
  }

  // Determine two primary teams by frequency
  const sortedTeams = Object.entries(teamCounts).sort((a, b) => b[1] - a[1]);
  const teamA = sortedTeams[0]?.[0] || 'Team A';
  const teamB = sortedTeams[1]?.[0] || 'Team B';

  // Colors
  const defaultPalette = ['#1F77B4', '#D62728', '#2CA02C', '#9467BD', '#FF7F0E'];
  const teamColors: Record<string, string> = {};
  const teamAColor = branding?.[teamA]?.primary;
  const teamBColor = branding?.[teamB]?.primary;
  const fallbackTeamA = defaultPalette[0] ?? '#1F77B4';
  const fallbackTeamB = defaultPalette[1] ?? '#D62728';
  teamColors[teamA] = resolveColor(teamAColor, fallbackTeamA);
  teamColors[teamB] = resolveColor(teamBColor, fallbackTeamB);

  return {
    teamA,
    teamB,
    teamColors,
    score,
    totalPlays: plays.length,
    playsByQuarter,
    playTypeCounts,
    formationCounts,
    formationMix,
    personnelCounts,
    downStats,
    scoringPlays
  };
}

function percent(part: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((part * 100) / total)}%`;
}

function generateSummarySectionHTML(stats: Stats): string {
  const total = stats.totalPlays || 1;
  const run = stats.playTypeCounts['Run'] || 0;
  const pass = stats.playTypeCounts['Pass'] || 0;
  const special = total - run - pass;

  // Top formations
  const formations = Object.entries(stats.formationCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const personnel = Object.entries(stats.personnelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return `
  <section class="summary">
    <div class="grid">
      <div class="card">
        <h3>Play Type Mix</h3>
        <ul class="kv">
          <li><span>Run</span><span>${run} (${percent(run, total)})</span></li>
          <li><span>Pass</span><span>${pass} (${percent(pass, total)})</span></li>
          <li><span>Special/Other</span><span>${special} (${percent(special, total)})</span></li>
          <li class="muted"><span>Total Plays</span><span>${total}</span></li>
        </ul>
      </div>
      <div class="card">
        <h3>Down & Distance</h3>
        <table class="compact">
          <thead><tr><th>Down</th><th>Plays</th><th>Avg Yds</th><th>Success</th></tr></thead>
          <tbody>
            ${([1,2,3,4] as const).map(d => {
              const s = stats.downStats[d];
              return `<tr><td>${d}</td><td>${s.count}</td><td>${s.avgYards}</td><td>${s.successRate || 0}%</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Top Formations</h3>
        <table class="compact">
          <thead><tr><th>Formation</th><th>Plays</th><th>Run</th><th>Pass</th></tr></thead>
          <tbody>
            ${formations.map(([f, c]) => {
              const mix: FormationMix = stats.formationMix[f] ?? { Run: 0, Pass: 0, Other: 0, total: 0 };
              return `<tr><td>${escapeHtml(f)}</td><td>${c}</td><td>${mix.Run}</td><td>${mix.Pass}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Personnel Usage</h3>
        <table class="compact">
          <thead><tr><th>Personnel</th><th>Plays</th></tr></thead>
          <tbody>
            ${personnel.map(([p, c]) => `<tr><td>${escapeHtml(p)}</td><td>${c}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </section>
  `;
}

function playRowClass(type: string | undefined): string {
  if (!type) return 'row-special';
  if (type === 'Run') return 'row-run';
  if (type === 'Pass') return 'row-pass';
  return 'row-special';
}

function renderPlaysTable(plays: FootballPlay[]): string {
  const rows = (plays || []).map((p, idx) => {
    const type = p.play?.play_type;
    const klass = playRowClass(type);
    const id = escapeHtml(p.play_id);
    const time = escapeHtml(p.game_context.game_clock || '');
    const off = escapeHtml(p.game_context.offense_team);
    const def = escapeHtml(p.game_context.defense_team);
    const dn = (p.situation?.down as number | undefined);
    const dist = (p.situation?.distance as number | undefined);
    const ddRaw = dn ? `${dn} & ${typeof dist === 'number' ? dist : '-'}` : '-';
    const dd = escapeHtml(ddRaw);
    const yl = escapeHtml(p.situation?.yard_line || '');
    const hash = escapeHtml((p.situation?.hash_mark as string | undefined) || '');
    const form = escapeHtml(p.pre_snap?.offense?.formation || '');
    const concept = type === 'Run'
      ? escapeHtml(p.play?.run_details?.concept || '')
      : escapeHtml(p.play?.pass_details?.concept || '');
    const yards = (typeof p.result?.yards_gained === 'number') ? p.result.yards_gained : 0;
    const outcome = escapeHtml(p.result?.outcome || '');
    return `
      <tr class="${klass}">
        <td>${idx + 1}</td>
        <td>${id}</td>
        <td>${time}</td>
        <td>${off} vs ${def}</td>
        <td>${dd}</td>
        <td>${yl}</td>
        <td>${hash}</td>
        <td>${form}</td>
        <td>${escapeHtml(type || '')}</td>
        <td>${concept}</td>
        <td class="num">${yards}</td>
        <td class="outcome">${outcome}</td>
      </tr>`;
  }).join('');

  return `
    <table class="plays">
      <thead>
        <tr>
          <th>#</th>
          <th>Play ID</th>
          <th>Time</th>
          <th>O vs D</th>
          <th>Dn&Dist</th>
          <th>Yard Line</th>
          <th>Hash</th>
          <th>Formation</th>
          <th>Type</th>
          <th>Concept</th>
          <th class="num">Yds</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function generatePlaysSectionHTML(title: string, plays: FootballPlay[]): string {
  if (!plays || plays.length === 0) return '';
  return `
    <section class="quarter-section">
      <h2>${escapeHtml(title)}</h2>
      ${renderPlaysTable(plays)}
    </section>
  `;
}

function generateQuarterSectionHTML(quarter: number, plays: FootballPlay[]): string {
  if (!plays.length) return '';
  return generatePlaysSectionHTML(`${ordinal(quarter)} Quarter`, plays);
}

function generateUnknownQuarterSectionHTML(plays: FootballPlay[]): string {
  if (!plays.length) return '';
  return generatePlaysSectionHTML('Unknown Quarter', plays);
}

function generateScoringSummaryHTML(stats: Stats): string {
  if (!stats.scoringPlays.length) return '<p class="muted">No scoring plays recorded.</p>';
  const rows = stats.scoringPlays.map(sp => `
    <tr>
      <td>${ordinal(sp.quarter)}</td>
      <td>${escapeHtml(sp.time || '-')}</td>
      <td>${escapeHtml(sp.team)}</td>
      <td>${escapeHtml(sp.type)}</td>
      <td class="num">${sp.points}</td>
      <td>${escapeHtml(sp.description)}</td>
    </tr>
  `).join('');
  return `
    <table class="compact w100">
      <thead><tr><th>Qtr</th><th>Time</th><th>Team</th><th>Type</th><th class="num">Pts</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function baseStyles(teamAColor: string, teamBColor: string): string {
  return `
  :root {
    --teamA: ${teamAColor};
    --teamB: ${teamBColor};
    --runRow: ${RUN_ROW_COLOR};
    --passRow: ${PASS_ROW_COLOR};
    --specialRow: ${SPECIAL_ROW_COLOR};
    --text: #222;
    --muted: #666;
    --border: #ddd;
    --card: #f9fafb;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Liberation Sans', sans-serif;
    color: var(--text);
    margin: 0;
    padding: 24px;
    font-size: 12px;
    line-height: 1.35;
  }
  header {
    border-bottom: 3px solid var(--border);
    margin-bottom: 16px;
    padding-bottom: 8px;
  }
  .title {
    background: linear-gradient(90deg, var(--teamA), var(--teamB));
    color: #fff;
    padding: 14px 16px;
    border-radius: 6px;
    margin-bottom: 12px;
  }
  .title h1 {
    margin: 0;
    font-size: 20px;
    letter-spacing: 0.3px;
  }
  .meta {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: #fff;
    opacity: 0.95;
  }
  .scoreline {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 6px 0 0 0;
    font-weight: bold;
  }
  .scoreline .teams {
    font-size: 14px;
  }
  .scoreline .score {
    font-size: 18px;
  }
  h2 {
    font-size: 16px;
    margin: 14px 0 8px 0;
    color: var(--text);
  }
  h3 {
    font-size: 13px;
    margin: 8px 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
  }
  .kv { list-style: none; padding: 0; margin: 0; }
  .kv li {
    display: flex; justify-content: space-between; padding: 2px 0;
    border-bottom: 1px dashed rgba(0,0,0,0.06);
  }
  .kv li:last-child { border-bottom: none; }
  .muted { color: var(--muted); }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 6px;
  }
  table.compact th, table.compact td {
    padding: 6px 8px;
    border: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
  }
  table.plays th, table.plays td {
    border: 1px solid var(--border);
    padding: 6px 6px;
  }
  table.plays th { background: #f1f3f5; }
  td.num { text-align: right; }
  td.outcome { width: 40%; }
  tr.row-run td { background-color: var(--runRow); }
  tr.row-pass td { background-color: var(--passRow); }
  tr.row-special td { background-color: var(--specialRow); }
  .w100 { width: 100%; }
  .quarter-section { page-break-inside: avoid; margin-top: 16px; }
  .quarter-section + .quarter-section { page-break-before: always; }
  footer {
    margin-top: 16px;
    font-size: 10px;
    color: var(--muted);
    text-align: center;
  }
  @page {
    size: A4;
    margin: 20mm 12mm;
    /* If the UA supports margin boxes, render page numbers via CSS counters */
    @bottom-right {
      content: "Page " counter(page) " of " counter(pages);
      font-size: 10px;
      color: var(--muted);
    }
  }
  `;
}

function generateDetailedHTML(analysis: FootballAnalysis, options?: PDFOptions): string {
  const stats = summarize(analysis, options?.branding);
  const dateStr = formatDate(options?.gameDate);
  const title = escapeHtml(options?.reportTitle || 'Football Game Analysis Report');
  const generatedAt = new Date().toLocaleString();
  const colorA = stats.teamColors[stats.teamA] ?? '#1F77B4';
  const colorB = stats.teamColors[stats.teamB] ?? '#D62728';

  const teamA = escapeHtml(stats.teamA);
  const teamB = escapeHtml(stats.teamB);
  const scoreA = stats.score[stats.teamA] ?? 0;
  const scoreB = stats.score[stats.teamB] ?? 0;

  const qSections = ([
    1, 2, 3, 4
  ] as const).map(q => generateQuarterSectionHTML(q, (stats.playsByQuarter[q] ?? []) as FootballPlay[])).join('');
  const unknownPlays = (analysis.plays || []).filter(p => {
    const q = p.game_context?.quarter;
    return !q || q === 0;
  });
  const unknownSection = generateUnknownQuarterSectionHTML(unknownPlays);

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <title>${title}</title>
    <style>${baseStyles(colorA, colorB)}</style>
  </head>
  <body>
    <header>
      <div class="title">
        <h1>${title}</h1>
        <div class="meta">
          <div><strong>Teams:</strong> ${teamA} vs ${teamB}</div>
          <div><strong>Date:</strong> ${dateStr}</div>
          ${options?.location ? `<div><strong>Location:</strong> ${escapeHtml(options?.location ?? '')}</div>` : ''}
        </div>
        <div class="scoreline">
          <span class="teams">${teamA} - ${teamB}</span>
          <span class="score">${scoreA} - ${scoreB}</span>
          <span class="muted">Total Plays: ${stats.totalPlays}</span>
        </div>
      </div>
    </header>

    <section>
      <h2>Game Summary</h2>
      ${generateSummarySectionHTML(stats)}
    </section>

    <section>
      <h2>Scoring Summary</h2>
      ${generateScoringSummaryHTML(stats)}
    </section>

    <section>
      <h2>Play-by-Play</h2>
      <p class="muted">Rows are color-coded by play type: Run (green), Pass (blue), Special/Other (amber). The Concept column reflects run/pass concept where identified.</p>
      ${qSections}
      ${unknownSection}
    </section>

    <footer>
      Generated by Football Video Analysis Tool • Generated: ${escapeHtml(generatedAt)}
    </footer>
  </body>
  </html>
  `;
  return html;
}

function generateSummaryHTML(analysis: FootballAnalysis, options?: PDFOptions): string {
  const stats = summarize(analysis, options?.branding);
  const dateStr = formatDate(options?.gameDate);
  const title = escapeHtml(options?.reportTitle || 'Football Game Summary Report');
  const generatedAt = new Date().toLocaleString();
  const colorA = stats.teamColors[stats.teamA] ?? '#1F77B4';
  const colorB = stats.teamColors[stats.teamB] ?? '#D62728';

  const teamA = escapeHtml(stats.teamA);
  const teamB = escapeHtml(stats.teamB);
  const scoreA = stats.score[stats.teamA] ?? 0;
  const scoreB = stats.score[stats.teamB] ?? 0;

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <title>${title}</title>
    <style>${baseStyles(colorA, colorB)}</style>
  </head>
  <body>
    <header>
      <div class="title">
        <h1>${title}</h1>
        <div class="meta">
          <div><strong>Teams:</strong> ${teamA} vs ${teamB}</div>
          <div><strong>Date:</strong> ${dateStr}</div>
          ${options?.location ? `<div><strong>Location:</strong> ${escapeHtml(options?.location ?? '')}</div>` : ''}
        </div>
        <div class="scoreline">
          <span class="teams">${teamA} - ${teamB}</span>
          <span class="score">${scoreA} - ${scoreB}</span>
          <span class="muted">Total Plays: ${stats.totalPlays}</span>
        </div>
      </div>
    </header>

    <section>
      <h2>Game Summary</h2>
      ${generateSummarySectionHTML(stats)}
    </section>

    <section>
      <h2>Scoring Summary</h2>
      ${generateScoringSummaryHTML(stats)}
    </section>

    <footer>
      Generated by Football Video Analysis Tool • Generated: ${escapeHtml(generatedAt)}
    </footer>
  </body>
  </html>
  `;
  return html;
}

export async function generatePDFReports(
  analysis: FootballAnalysis,
  options?: PDFOptions
): Promise<{ detailedPath: string; summaryPath: string }> {
  const detailedPath = path.resolve(process.cwd(), options?.outputPathDetailed || 'football_analysis.pdf');
  const summaryPath = path.resolve(process.cwd(), options?.outputPathSummary || 'football_analysis_summary.pdf');

  const detailedHTML = generateDetailedHTML(analysis, options);
  const summaryHTML = generateSummaryHTML(analysis, options);

  // Timestamp and page numbers in header/footer templates (reliable in Chromium)
  const generatedAt = new Date().toLocaleString();
  const headerTemplate = '<div style="font-size:8px; color: transparent;">.</div>';
  const footerTemplate = `
    <div style="font-size:10px; width: 100%; padding: 0 12px; color: #666; display: flex; justify-content: space-between;">
      <span>Generated: ${escapeHtml(generatedAt)}</span>
      <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>
  `;

  const sandboxEnv = process.env.PUPPETEER_NO_SANDBOX?.trim().toLowerCase();
  const disableSandbox = sandboxEnv === '1' || sandboxEnv === 'true' || sandboxEnv === 'yes';

  const args: string[] = [];
  if (disableSandbox) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const headlessEnv = process.env.PUPPETEER_HEADLESS?.trim().toLowerCase();
  let headlessOption: boolean | 'shell' | undefined;
  if (headlessEnv) {
    if (['false', '0', 'no'].includes(headlessEnv)) {
      headlessOption = false;
    } else if (headlessEnv === 'shell') {
      headlessOption = 'shell';
    } else {
      headlessOption = true;
    }
  }

  const launchOptions: LaunchOptions & { headless?: boolean | 'shell' } = {};
  if (args.length > 0) {
    launchOptions.args = args;
  }
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  if (typeof headlessOption !== 'undefined') {
    launchOptions.headless = headlessOption;
  }

  let browser: Browser | null = null;
  try {
    try {
      browser = await puppeteer.launch(launchOptions);
    } catch (err) {
      const guidance = 'Set PUPPETEER_EXECUTABLE_PATH to a Chrome/Chromium binary or install dependencies for the bundled Chromium.';
      const details = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to launch Chromium via Puppeteer. ${guidance}\nOriginal error: ${details}`);
    }

    if (!browser) {
      throw new Error('Puppeteer.launch returned no browser instance.');
    }

    // Detailed
    const page1 = await browser.newPage();
    await page1.setContent(detailedHTML, { waitUntil: 'networkidle0' });
    await page1.pdf({
      path: detailedPath,
      printBackground: true,
      format: 'A4',
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: '20mm', bottom: '25mm', left: '12mm', right: '12mm' }
    });
    await page1.close();

    // Summary
    const page2 = await browser.newPage();
    await page2.setContent(summaryHTML, { waitUntil: 'networkidle0' });
    await page2.pdf({
      path: summaryPath,
      printBackground: true,
      format: 'A4',
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      margin: { top: '20mm', bottom: '25mm', left: '12mm', right: '12mm' }
    });
    await page2.close();
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return { detailedPath, summaryPath };
}