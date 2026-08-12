/**
 * hours.js — how long did the AI actually work?
 *
 * Every existing Claude Code monitor measures tokens, dollars, or quota
 * percentages. None measure *time*. This one answers "how many agent-hours did
 * I run today", counting main sessions and subagents alike.
 *
 * The measurement is deliberately conservative — an hour count is only
 * interesting if it is honest, and the easy mistakes all inflate it:
 *
 *  - A turn is NOT "user asked → assistant finished". That span includes every
 *    minute the agent sat blocked on a permission prompt. Measured on a real
 *    session: naive spans said 10.97h, actual work was 4.39h.
 *  - Instead we sum the gaps *between consecutive entries* and drop any gap
 *    longer than IDLE_GAP_S. While an agent is genuinely working it writes
 *    every few seconds (measured: median 3.4s, p95 42s), so a minute of silence
 *    means it stopped — waiting on you, or dead.
 *  - Within one agent, overlapping activity is never counted twice.
 *
 * Parallel agents DO add up: two agents working the same minute is two
 * agent-minutes. That is the whole point — it is what a human team costs.
 * Wall-clock time (the union across agents) is reported alongside so the two
 * are never confused.
 *
 * Zero dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const IDLE_GAP_S = 60;       // silence longer than this = the agent stopped working
const HOURS_PER_PERSON_DAY = 8;
const DAYS_PER_PERSON_MONTH = 20;

function defaultBaseDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** All transcripts, main and subagent alike. */
function listTranscripts(baseDir) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push({ file: full, isSubagent: full.includes(`${path.sep}subagents${path.sep}`) });
      }
    }
  };
  walk(baseDir);
  return out;
}

/**
 * Timestamps of entries that prove the agent was doing something, in ms.
 * user/assistant only: the other entry types (mode, bridge-session, snapshots…)
 * are bookkeeping the runtime writes on its own schedule, not evidence of work.
 */
function activityStamps(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (!e || !e.timestamp) continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Busy intervals from a sorted stamp list: consecutive stamps closer than
 * idleGapS belong to the same interval. A lone stamp has zero duration — we
 * credit no time we cannot see, rather than guessing a "typical" turn length.
 * @returns {Array<[number, number]>} [startMs, endMs]
 */
function busyIntervals(stamps, idleGapS = IDLE_GAP_S) {
  const gapMs = idleGapS * 1000;
  const out = [];
  let start = null, prev = null;
  for (const t of stamps) {
    if (prev === null) { start = prev = t; continue; }
    if (t - prev > gapMs) {
      if (prev > start) out.push([start, prev]);
      start = t;
    }
    prev = t;
  }
  if (prev !== null && prev > start) out.push([start, prev]);
  return out;
}

/** Total seconds covered, merging overlaps (union). */
function unionSeconds(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > ce) { total += ce - cs; cs = s; ce = e; }
    else if (e > ce) ce = e;
  }
  total += ce - cs;
  return total / 1000;
}

/** Clip intervals to [from, to); drops anything outside. */
function clipIntervals(intervals, from, to) {
  const out = [];
  for (const [s, e] of intervals) {
    const cs = Math.max(s, from), ce = Math.min(e, to);
    if (ce > cs) out.push([cs, ce]);
  }
  return out;
}

/** Split a day's ms range in local time. */
function dayRange(date) {
  const s = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return [s, s + 86400000];
}

function personUnits(hours) {
  const personDays = hours / HOURS_PER_PERSON_DAY;
  return { personDays, personMonths: personDays / DAYS_PER_PERSON_MONTH };
}

/**
 * Scan transcripts into per-agent busy intervals.
 * @returns {{agents: Array, baseDir: string}}
 */
function scan(opts) {
  opts = opts || {};
  const baseDir = opts.baseDir || defaultBaseDir();
  const idleGapS = opts.idleGapS || IDLE_GAP_S;
  const agents = [];
  for (const t of listTranscripts(baseDir)) {
    let stamps;
    try { stamps = activityStamps(fs.readFileSync(t.file, 'utf8')); } catch (e) { continue; }
    if (stamps.length < 2) continue;
    const intervals = busyIntervals(stamps, idleGapS);
    if (!intervals.length) continue;
    const rel = path.relative(baseDir, t.file);
    agents.push({
      file: t.file,
      isSubagent: t.isSubagent,
      project: rel.split(path.sep)[0],
      intervals,
      seconds: unionSeconds(intervals),
      firstMs: intervals[0][0],
      lastMs: intervals[intervals.length - 1][1],
    });
  }
  return { agents, baseDir };
}

/**
 * Aggregate agents over a window.
 * agentHours: parallel work adds up (the headline number).
 * wallHours:  union across all agents — real elapsed time you spent.
 */
function summarize(agents, from, to) {
  let agentSec = 0, mainSec = 0, subSec = 0, longestSec = 0;
  const all = [];
  const projects = {};
  let mainCount = 0, subCount = 0;
  for (const a of agents) {
    const clipped = clipIntervals(a.intervals, from, to);
    if (!clipped.length) continue;
    const sec = unionSeconds(clipped);
    for (const [s2, e2] of clipped) if ((e2 - s2) / 1000 > longestSec) longestSec = (e2 - s2) / 1000;
    agentSec += sec;
    if (a.isSubagent) { subSec += sec; subCount++; } else { mainSec += sec; mainCount++; }
    projects[a.project] = (projects[a.project] || 0) + sec;
    all.push(...clipped);
  }
  const wallSec = unionSeconds(all);
  const agentHours = agentSec / 3600;
  return {
    agentHours,
    wallHours: wallSec / 3600,
    mainHours: mainSec / 3600,
    subagentHours: subSec / 3600,
    parallelism: wallSec ? agentSec / wallSec : 0,
    longestRunHours: longestSec / 3600,
    agentCount: mainCount + subCount,
    mainCount,
    subCount,
    projects: Object.entries(projects)
      .map(([name, sec]) => ({ name, hours: sec / 3600 }))
      .sort((a, b) => b.hours - a.hours),
    ...personUnits(agentHours),
  };
}

/** Month key (local) for a ms timestamp. */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Per-month rollup. Reports observed days and a 30-day-normalised rate, because
 * a raw month total is unreadable when the month is partial — or when Claude
 * Code's 30-day cleanup already ate the start of it.
 */
function byMonth(agents, now) {
  const buckets = {};
  for (const a of agents) {
    for (const iv of a.intervals) {
      const k = monthKey(iv[0]);
      (buckets[k] = buckets[k] || { intervals: [], sub: 0, main: 0 }).intervals.push(iv);
      const sec = (iv[1] - iv[0]) / 1000;
      if (a.isSubagent) buckets[k].sub += sec; else buckets[k].main += sec;
    }
  }
  return Object.keys(buckets).sort().map((k) => {
    const b = buckets[k];
    let agentSec = 0, longest = 0;
    for (const [s, e] of b.intervals) { agentSec += (e - s) / 1000; if ((e - s) / 1000 > longest) longest = (e - s) / 1000; }
    const first = Math.min(...b.intervals.map((x) => x[0]));
    const last = Math.max(...b.intervals.map((x) => x[1]));
    const observedDays = Math.max(1, (last - first) / 86400000);
    const hours = agentSec / 3600;
    const per30 = hours / observedDays * 30;
    return {
      month: k, hours,
      wallHours: unionSeconds(b.intervals) / 3600,
      mainHours: b.main / 3600,
      subagentHours: b.sub / 3600,
      observedDays,
      hoursPer30Days: per30,
      longestRunHours: longest / 3600,
      personMonthsPerMonth: per30 / (HOURS_PER_PERSON_DAY * DAYS_PER_PERSON_MONTH),
      partial: monthKey(now || Date.now()) === k,
    };
  });
}

/** Seconds of agent work per hour-of-day (0-23), local time. Used for the night share. */
function byClockHour(agents, from, to) {
  const hours = new Array(24).fill(0);
  for (const a of agents) {
    for (const [s, e] of clipIntervals(a.intervals, from, to)) {
      // walk the interval hour by hour so a long run is attributed correctly
      let t = s;
      while (t < e) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const end = Math.min(e, nextHour);
        hours[d.getHours()] += (end - t) / 1000;
        t = end;
      }
    }
  }
  return hours;
}

/**
 * Day × hour matrix of agent-seconds: grid[dayIndex][hour], day 0 = the day
 * containing `from` (local time). The card's heatmap — a month of AI runtime
 * as one picture, measured the same way as everything else (interval walking,
 * no guessing).
 */
function byDayHour(agents, from, to) {
  const days = Math.max(1, Math.ceil((to - from) / 86400000));
  const grid = Array.from({ length: days }, () => new Array(24).fill(0));
  const day0 = dayRange(new Date(from))[0];
  for (const a of agents) {
    for (const [s, e] of clipIntervals(a.intervals, from, to)) {
      let t = s;
      while (t < e) {
        const d = new Date(t);
        const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
        const end = Math.min(e, nextHour);
        const di = Math.floor((dayRange(d)[0] - day0) / 86400000);
        if (di >= 0 && di < days) grid[di][d.getHours()] += (end - t) / 1000;
        t = end;
      }
    }
  }
  return grid;
}

/** Share of work done between `startH` and `endH` (e.g. 0–6 = while you were asleep). */
function nightShare(clockHours, startH = 0, endH = 6) {
  const total = clockHours.reduce((a, b) => a + b, 0);
  if (!total) return { seconds: 0, share: 0 };
  let night = 0;
  for (let h = startH; h < endH; h++) night += clockHours[h];
  return { seconds: night, share: night / total };
}

module.exports = {
  IDLE_GAP_S, HOURS_PER_PERSON_DAY, DAYS_PER_PERSON_MONTH,
  defaultBaseDir, listTranscripts, activityStamps, busyIntervals,
  unionSeconds, clipIntervals, dayRange, personUnits, scan, summarize,
  monthKey, byMonth, byClockHour, byDayHour, nightShare,
};
