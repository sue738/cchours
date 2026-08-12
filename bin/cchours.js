#!/usr/bin/env node
/**
 * cchours — how many hours did your AI actually run?
 *
 *   npx cchours              daily table
 *   npx cchours --monthly    per-month, normalised to 30 days
 *   npx cchours --card       a card you can paste anywhere
 */
'use strict';

const fs = require('fs');
const H = require('../lib/hours.js');
const R = require('../lib/render.js');

const JA = /^ja/i.test(process.env.CCHOURS_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

const HELP = `cchours — how many hours did your AI actually run?

Usage:
  cchours [period] [options]

Period:
  --daily          per-day table (default)
  --monthly        per-month, normalised to a 30-day rate
  --today          today only
  --week           last 7 days
  --month          this month
  --all            everything still on disk
  --since YYYYMMDD / --until YYYYMMDD

Output:
  --card           shareable card, last 30 days (--card --week for 7 days)
  --svg [path]     write the card as an image (default cchours.svg)
  --json           machine-readable
  --caps           show the same period at several idle caps (honesty band)
  --by-project     rank projects

Tuning:
  --idle-gap N     silence (seconds) counted as "stopped" (default ${H.IDLE_GAP_S})
  --base-dir D     transcript root (default ~/.claude/projects)

Counts main sessions and subagents. Parallel agents add up — wall-clock time is
always shown beside them so the two can't be confused.`;

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--monthly') o.monthly = true;
    else if (a === '--daily') o.daily = true;
    else if (a === '--today') o.today = true;
    else if (a === '--week') o.days = 7;
    else if (a === '--month') o.thisMonth = true;
    else if (a === '--all') o.all = true;
    else if (a === '--days') o.days = +argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--until') o.until = argv[++i];
    else if (a === '--card') o.card = true;
    else if (a === '--svg') { o.svg = (argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[++i] : 'cchours.svg'; }
    else if (a === '--json') o.json = true;
    else if (a === '--theme') o.theme = argv[++i];
    else if (a === '--caps') o.caps = true;
    else if (a === '--by-project') o.byProject = true;
    else if (a === '--idle-gap') o.idleGapS = +argv[++i];
    else if (a === '--base-dir') o.baseDir = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  }
  return o;
}

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

/**
 * Resolve the requested window.
 *
 * Tables default to everything on disk, but the card defaults to a fixed
 * 30 days: a card is made to be compared with someone else's, and "all of my
 * history" is a different length for every person (and depends on their
 * cleanupPeriodDays). Same window or the comparison is meaningless.
 */
function resolveRange(o, agents, now) {
  const to = o.until ? parseDate(o.until) + 86400000 : Date.now();
  if (o.since) return { from: parseDate(o.since), to, label: L(`${o.since} →`, `${o.since} 以降`) };
  if (o.today) return { from: H.dayRange(now)[0], to, label: L('Today', '今日') };
  if (o.days) return { from: H.dayRange(new Date(now - (o.days - 1) * 86400000))[0], to, label: L(`Last ${o.days} days`, `直近${o.days}日`) };
  if (o.thisMonth) return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to, label: L('This month', '今月') };
  if ((o.card || o.svg) && !o.all) {
    return { from: H.dayRange(new Date(now - 29 * 86400000))[0], to, label: L('last 30 days', '直近30日') };
  }
  const from = Math.min(...agents.map((a) => a.firstMs));
  const days = Math.max(1, Math.round((to - from) / 86400000));
  return { from, to, label: L(days === 1 ? `1 day on disk` : `${days} days on disk`, `ディスク上の${days}日間`) };
}

function main() {
  const o = parseArgs(process.argv);
  const { agents } = H.scan(o);
  if (!agents.length) {
    console.log(L('(no transcripts found under ~/.claude/projects)', '(~/.claude/projects に transcript がありません)'));
    return;
  }
  const now = new Date();
  const { from, to, label } = resolveRange(o, agents, now);

  // ---- share card ----
  if (o.card || o.svg) {
    const s = H.summarize(agents, from, to);
    const clock = H.byClockHour(agents, from, to);
    const grid = H.byDayHour(agents, from, to);
    const night = H.nightShare(clock);
    // A card that only covers part of its window would invite unfair comparison,
    // so say how much data actually backs it when history is shorter than asked.
    const oldest = Math.min(...agents.map((a) => a.firstMs));
    const covered = Math.max(1, Math.ceil((to - Math.max(from, oldest)) / 86400000));
    const asked = Math.round((to - from) / 86400000);
    const d = {
      label: (o.monthly || o.thisMonth) ? H.monthKey(from)
        : (covered < asked - 1 ? L(`last 30 days (${covered}d of history)`, `直近30日(履歴は${covered}日分)`) : label),
      hours: s.agentHours,
      personMonths: s.personMonths,
      subShare: s.agentHours ? s.subagentHours / s.agentHours : 0,
      nightShare: night.share,
      parallelism: s.parallelism,
      subCount: s.subCount,
      wallHours: s.wallHours,
      grid,
    };
    if (o.svg) {
      fs.writeFileSync(o.svg, R.cardSvg(d, JA));
      console.log(L(`wrote ${o.svg}`, `${o.svg} を書き出しました`));
    }
    if (o.card || !o.svg) console.log('\n' + R.card(d, JA) + '\n');
    return;
  }

  // ---- honesty band: the same period at several idle caps ----
  if (o.caps) {
    const rows = [];
    for (const cap of [30, 60, 120, 300, 600, 900]) {
      const { agents: ag } = H.scan(Object.assign({}, o, { idleGapS: cap }));
      const s = H.summarize(ag, from, to);
      rows.push([`${cap}s`, R.fmtH(s.agentHours), R.fmtH(s.wallHours), `×${s.parallelism.toFixed(1)}`]);
    }
    console.log(R.banner(L(`cchours — idle-cap band (${label})`, `cchours — 上限別の稼働時間 (${label})`)));
    console.log(R.table([L('idle cap', '停止とみなす沈黙'), L('agent-hrs', '延べ稼働'), L('wall', '実経過'), L('parallel', '並列')], rows));
    console.log(L('\nNo single cap is "the truth" — a wider cap credits longer silences as work.',
      '\nどれか1つが「正解」ではない。上限を広げるほど長い沈黙も稼働に数える。'));
    return;
  }

  // ---- by project ----
  if (o.byProject) {
    const s = H.summarize(agents, from, to);
    const rows = s.projects.map((p) => {
      const name = p.name.split('-').filter(Boolean).pop() || p.name;
      return [name.slice(0, 28), R.fmtH(p.hours), R.bar(p.hours / s.projects[0].hours, 16)];
    });
    console.log(R.banner(L(`cchours — by project (${label})`, `cchours — プロジェクト別 (${label})`)));
    console.log(R.table([L('project', 'プロジェクト'), L('agent-hrs', '延べ稼働'), ''], rows,
      { align: ['l', 'r', 'l'], totalRow: [L('Total', '合計'), R.fmtH(s.agentHours), ''] }));
    return;
  }

  // ---- monthly ----
  if (o.monthly) {
    const months = H.byMonth(agents, now.getTime());
    if (o.json) return console.log(JSON.stringify(months, null, 2));
    const rows = months.map((m) => [
      m.month + (m.partial ? '*' : ''),
      `${m.observedDays.toFixed(0)}d`,
      R.fmtH(m.hours),
      R.fmtH(m.hoursPer30Days),
      m.personMonthsPerMonth.toFixed(2),
      R.fmtH(m.subagentHours),
    ]);
    console.log(R.banner(L('cchours — monthly', 'cchours — 月別')));
    console.log(R.table(
      [L('month', '月'), L('observed', '観測'), L('agent-hrs', '延べ稼働'), L('per 30d', '30日換算'), L('person-mo', '人月/月'), L('subagents', 'サブ')],
      rows));
    console.log(L('\n* = month still running. "per 30d" scales the observed span, because Claude Code',
      '\n* = 進行中の月。「30日換算」は観測期間で割り戻した値 — Claude Code の'));
    console.log(L('  deletes transcripts after cleanupPeriodDays, so early months are usually partial.',
      '  transcript は cleanupPeriodDays で消えるため、古い月はたいてい欠けている。'));
    console.log(L(`  person-month = ${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}d = ${H.HOURS_PER_PERSON_DAY * H.DAYS_PER_PERSON_MONTH}h of machine time. Not a productivity claim.`,
      `  人月 = ${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}日 = ${H.HOURS_PER_PERSON_DAY * H.DAYS_PER_PERSON_MONTH}時間の"機械の稼働時間"。生産性の主張ではない。`));
    return;
  }

  // ---- daily (default) ----
  const rows = [];
  for (let d = new Date(from); d.getTime() < to; d = new Date(d.getTime() + 86400000)) {
    const [ds, de] = H.dayRange(d);
    const s = H.summarize(agents, ds, de);
    if (s.agentHours <= 0) continue;
    rows.push([
      new Date(ds).toISOString().slice(0, 10),
      R.fmtH(s.agentHours), R.fmtH(s.wallHours), `×${s.parallelism.toFixed(1)}`,
      R.fmtH(s.mainHours), R.fmtH(s.subagentHours),
    ]);
  }
  const tot = H.summarize(agents, from, to);
  if (o.json) return console.log(JSON.stringify({ from, to, ...tot }, null, 2));
  console.log(R.banner(L(`cchours — daily (${label})`, `cchours — 日別 (${label})`)));
  console.log(R.table(
    [L('date', '日付'), L('agent-hrs', '延べ稼働'), L('wall', '実経過'), L('parallel', '並列'), L('main', 'メイン'), L('subagents', 'サブ')],
    rows,
    { totalRow: [L('Total', '合計'), R.fmtH(tot.agentHours), R.fmtH(tot.wallHours), `×${tot.parallelism.toFixed(1)}`, R.fmtH(tot.mainHours), R.fmtH(tot.subagentHours)] }));
  if (tot.personMonths >= 0.1) {
    console.log(L(`\n  = ${tot.personMonths.toFixed(2)} person-months of machine time (${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}d). Try: cchours --monthly, cchours --card`,
      `\n  = 人月換算 ${tot.personMonths.toFixed(2)} 人月ぶんの稼働 (${H.HOURS_PER_PERSON_DAY}h × ${H.DAYS_PER_PERSON_MONTH}日)。月別: cchours --monthly / 共有: cchours --card`));
  }
}

main();
