/** test.js — zero-dep tests for cchours. Run: node test/test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('../lib/hours.js');
const R = require('../lib/render.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };
const T = (s) => new Date(2026, 0, 1, 12, 0, s).getTime(); // 12:00:00 + s秒

console.log('== busyIntervals (かさましを構造的に防ぐ中核) ==');
ok('連続した打刻は1区間', H.busyIntervals([T(0), T(5), T(10)]).length === 1);
ok('区間長は最初と最後の差', H.busyIntervals([T(0), T(5), T(10)])[0][1] - H.busyIntervals([T(0), T(5), T(10)])[0][0] === 10000);
ok('★60秒超の沈黙は分断(許可待ちを稼働に数えない)',
  H.busyIntervals([T(0), T(10), T(300), T(310)]).length === 2);
ok('★分断された間の290秒は加算されない',
  Math.round(H.unionSeconds(H.busyIntervals([T(0), T(10), T(300), T(310)]))) === 20);
ok('境界: ちょうど60秒は継続(>で判定)', H.busyIntervals([T(0), T(60)]).length === 1);
ok('境界: 61秒は分断', H.busyIntervals([T(0), T(61)]).length === 0); // 単発2つ=長さ0で捨てられる
ok('★孤立した打刻は0秒(推測で時間を足さない)', H.unionSeconds(H.busyIntervals([T(0)])) === 0);
ok('空入力', H.busyIntervals([]).length === 0);
ok('idleGap変更が効く', H.busyIntervals([T(0), T(100)], 120).length === 1);

console.log('== unionSeconds (二重計上を防ぐ) ==');
ok('重複区間はマージ', H.unionSeconds([[T(0), T(100)], [T(50), T(150)]]) === 150);
ok('離れた区間は加算', H.unionSeconds([[T(0), T(10)], [T(100), T(120)]]) === 30);
ok('内包される区間', H.unionSeconds([[T(0), T(100)], [T(10), T(20)]]) === 100);
ok('順不同でも正しい', H.unionSeconds([[T(100), T(120)], [T(0), T(10)]]) === 30);
ok('空', H.unionSeconds([]) === 0);

console.log('== clipIntervals (期間の切り出し) ==');
ok('範囲内はそのまま', H.clipIntervals([[T(10), T(20)]], T(0), T(100)).length === 1);
ok('範囲外は落とす', H.clipIntervals([[T(200), T(300)]], T(0), T(100)).length === 0);
ok('またがる区間は切る', H.clipIntervals([[T(50), T(200)]], T(0), T(100))[0][1] === T(100));

console.log('== activityStamps (証拠のあるエントリだけ数える) ==');
const mk = (o) => JSON.stringify(o);
const text = [
  mk({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
  mk({ type: 'assistant', timestamp: '2026-01-01T00:00:05.000Z' }),
  mk({ type: 'mode', timestamp: '2026-01-01T00:00:06.000Z' }),        // 記録系は除外
  mk({ type: 'bridge-session', timestamp: '2026-01-01T00:00:07.000Z' }), // 同上
  mk({ type: 'assistant' }),                                            // timestamp無しは除外
  '{"broken',
].join('\n');
ok('user/assistantのみ2件', H.activityStamps(text).length === 2);
ok('壊れ行で落ちない', H.activityStamps('garbage\n' + text).length === 2);
ok('昇順に整列', (() => { const s = H.activityStamps(text); return s[0] <= s[1]; })());

console.log('== summarize (並列は足す・実経過は union) ==');
{
  const from = T(0), to = T(1000);
  // 2エージェントが同じ100秒間だけ働いた
  const agents = [
    { isSubagent: false, project: 'p1', intervals: [[T(0), T(100)]], firstMs: T(0), lastMs: T(100) },
    { isSubagent: true, project: 'p1', intervals: [[T(0), T(100)]], firstMs: T(0), lastMs: T(100) },
  ];
  const s = H.summarize(agents, from, to);
  ok('★延べ稼働は並列ぶん加算(200秒)', Math.round(s.agentHours * 3600) === 200);
  ok('★実経過は重複を除く(100秒)', Math.round(s.wallHours * 3600) === 100);
  ok('並列度 = 延べ/実経過', s.parallelism === 2);
  ok('★最長連続稼働(単一区間の最大長)', Math.round(s.longestRunHours * 3600) === 100);
  ok('メイン/サブを分けて集計', Math.round(s.mainHours * 3600) === 100 && Math.round(s.subagentHours * 3600) === 100);
  ok('件数', s.mainCount === 1 && s.subCount === 1 && s.agentCount === 2);
  ok('プロジェクト別合計', Math.round(s.projects[0].hours * 3600) === 200);
  const empty = H.summarize(agents, T(500), T(600));
  ok('範囲外は0(0除算しない)', empty.agentHours === 0 && empty.parallelism === 0);

  // == 最長連続の単位 ==
  // ここは3回作り直して3回とも壊した箇所。壊し方が毎回違うので3方向から留める。
  const P = '/x/proj/sess-a.jsonl';
  const S = '/x/proj/sess-a/subagents/agent-1.jsonl';
  const O = '/x/proj/sess-b.jsonl';

  // (1) 親がサブエージェントを待っている間は稼働。親子は同じ run に属する。
  //     ファイル名は <sess>.jsonl と <sess>/subagents/... で形が違うので、
  //     正規化を誤ると別グループに落ちて統合されない(実際に落ちた)。
  const handoff = H.summarize([
    { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(50)], [T(150), T(200)]] },
    { file: S, isSubagent: true, project: 'p', intervals: [[T(50), T(150)]] },
  ], from, to);
  ok('★親子は統合され、受け渡しで切れない(200秒)',
     Math.round(handoff.longestRunHours * 3600) === 200);

  // (2) たまたま同時刻に走っていた別セッションを繋いではいけない。
  //     全体を1本に統合したとき、無関係な24セッションが1つの run になった。
  const unrelated = H.summarize([
    { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(100)]] },
    { file: O, isSubagent: false, project: 'p', intervals: [[T(90), T(300)]] },
  ], from, to);
  ok('★別セッションは重なっていても統合しない(210秒)',
     Math.round(unrelated.longestRunHours * 3600) === 210);

  // (3) 不変条件: 統合は区間を伸ばすことしかしない。どんな入力でも
  //     「統合後の最長 >= 個々の区間の最長」。破れたら実装が壊れている。
  const any = [
    { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(30)], [T(200), T(260)]] },
    { file: S, isSubagent: true, project: 'p', intervals: [[T(20), T(80)]] },
    { file: O, isSubagent: false, project: 'p', intervals: [[T(400), T(455)]] },
  ];
  const rawMax = Math.max(...any.flatMap((a) => a.intervals.map(([s2, e2]) => e2 - s2)));
  ok('★不変条件: 統合後の最長は個々の最長を下回らない',
     H.summarize(any, from, to).longestRunHours * 3600000 >= rawMax);

  // (4) file を持たない呼び出し(直接 intervals を渡す既存の使い方)を壊さない。
  ok('file 無しでも落ちない', typeof H.summarize(agents, from, to).longestRunHours === 'number');

  // == ピーク同時稼働 ==
  const peak3 = H.summarize([
    { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(100)]] },
    { file: O, isSubagent: false, project: 'p', intervals: [[T(10), T(90)]] },
    { file: '/x/proj/sess-c.jsonl', isSubagent: false, project: 'p', intervals: [[T(20), T(80)]] },
  ], from, to);
  ok('★ピークは同時に走った最大数', peak3.peakParallel === 3);
  ok('平均とピークは別物', peak3.parallelism < peak3.peakParallel);
  ok('端が接するだけなら同時ではない',
     H.summarize([
       { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(50)]] },
       { file: O, isSubagent: false, project: 'p', intervals: [[T(50), T(100)]] },
     ], from, to).peakParallel === 1);

  // == セッション内ピーク ==
  // 全体ピークは「10セッションが3並列」と「1セッションが30並列」を同じ数字にする。
  // 正反対の診断なのに区別できず、実際にこの数字を読んで逆の結論を出した。
  // 並列度の上限が語るのは常に後者なので、セッション単位でも測る。
  ok('★別セッションの重なりはセッション内ピークに数えない',
     peak3.peakParallel === 3 && peak3.peakParallelSession === 1);

  const fanout = H.summarize([
    { file: P, isSubagent: false, project: 'p', intervals: [[T(0), T(100)]] },
    { file: S, isSubagent: true, project: 'p', intervals: [[T(10), T(90)]] },
    { file: '/x/proj/sess-a/subagents/agent-2.jsonl', isSubagent: true, project: 'p', intervals: [[T(20), T(80)]] },
  ], from, to);
  ok('★同一セッションのファンアウトは数える', fanout.peakParallelSession === 3);

  // 不変条件: セッション内ピークは全体ピークの部分集合から出るので、超えない。
  // 破れたらグループ分けが壊れている。
  ok('★不変条件: セッション内ピーク <= 全体ピーク',
     peak3.peakParallelSession <= peak3.peakParallel &&
     fanout.peakParallelSession <= fanout.peakParallel);
}

console.log('== personUnits (換算は固定係数・盛らない) ==');
ok('8時間=1人日', H.personUnits(8).personDays === 1);
ok('160時間=1人月(8h×20日)', H.personUnits(160).personMonths === 1);

console.log('== byMonth / byClockHour / nightShare ==');
{
  const jul = new Date(2026, 6, 10, 12).getTime();
  const aug = new Date(2026, 7, 5, 12).getTime();
  const agents = [
    { isSubagent: false, project: 'p', intervals: [[jul, jul + 3600000], [aug, aug + 7200000]] },
    { isSubagent: true, project: 'p', intervals: [[jul + 100, jul + 3600000]] },
  ];
  const ms = H.byMonth(agents, new Date(2026, 7, 11).getTime());
  ok('月ごとに分かれる', ms.length === 2 && ms[0].month === '2026-07' && ms[1].month === '2026-08');
  ok('サブエージェント分を月別に按分', Math.round(ms[0].subagentHours) === 1);
  ok('★進行中の月にフラグ', ms[1].partial === true && ms[0].partial === false);
  ok('30日換算は観測日数で割り戻す', ms[1].hoursPer30Days === ms[1].hours / ms[1].observedDays * 30);
  ok('人月/月 = 30日換算/160h', Math.abs(ms[1].personMonthsPerMonth - ms[1].hoursPer30Days / 160) < 1e-9);

  // 深夜帯: 23:30→00:30 の1時間は 30分ずつ2つの時間帯へ
  const night = new Date(2026, 6, 10, 23, 30).getTime();
  const clock = H.byClockHour([{ isSubagent: false, project: 'p', intervals: [[night, night + 3600000]] }], 0, Date.now());
  ok('★時間帯を跨ぐ区間を正しく分割', Math.round(clock[23]) === 1800 && Math.round(clock[0]) === 1800);
  ok('深夜0-6時の割合', Math.abs(H.nightShare(clock).share - 0.5) < 1e-6);
  ok('稼働ゼロでも0除算しない', H.nightShare(new Array(24).fill(0)).share === 0);
}

console.log('== render (表とカード) ==');
ok('fmtH: 分と時間', R.fmtH(0.5) === '30m' && R.fmtH(2.05) === '2h03m');
ok('width: 全角は2カラム', R.width('あa') === 3);
ok('padEndW: 全角混在で桁が揃う', R.width(R.padEndW('あa', 8)) === 8);
{
  const t = R.table(['a', 'b'], [['1', '2']], { totalRow: ['計', '3'] });
  ok('table: 枠と行', t.includes('┌') && t.includes('│ a') && t.includes('計'));
  const lens = t.split('\n').map((l) => R.width(l));
  ok('★table: 全行の表示幅が揃う', new Set(lens).size === 1);
}
ok('bar: 割合どおりの長さ', R.bar(0.5, 10) === '█████░░░░░');
ok('bar: 範囲外を丸める', R.bar(2, 4) === '████' && R.bar(-1, 4) === '░░░░');
{
  const d = { label: 'last 30 days', hours: 265, personMonths: 1.65, subShare: 0.51,
    nightShare: 0.19, parallelism: 1.8, subCount: 2258, wallHours: 161,
    grid: [[3600, 0, 1800].concat(new Array(21).fill(0))] };
  const c = R.card(d, false);
  ok('card: 時間とnpx導線', c.includes('265h00m') && c.includes('npx cchours'));
  ok('★card: 人月換算を出さない(誤読防止)', !c.includes('person-month'));
  ok('card: サブエージェントのバー1本', (c.match(/█/g) || []).length > 0 && c.includes('51%') && !c.includes('19%'));
  ok('card: 日本語', R.card(d, true).includes('サブエージェント'));
  const svg = R.cardSvg(d, false);
  ok('svg: 自己完結(外部参照なし)', svg.startsWith('<svg') && !/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')));
  ok('svg: エスケープ', R.cardSvg(Object.assign({}, d, { label: 'a<b&c' }), false).includes('a&lt;b&amp;c'));
  ok('★svg: ヒートマップのマスを描く(草)', (svg.match(/<rect/g) || []).length > 20 && svg.includes('#39d353'));
  ok('svg: 空グリッドでも落ちない', R.cardSvg(Object.assign({}, d, { grid: [] }), false).startsWith('<svg'));
}

console.log('== scan + CLI (fixtures) ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cchours-'));
const base = path.join(tmp, 'projects');
function mkT(rel, stampsSec) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(f, stampsSec.map((s, i) => JSON.stringify({
    type: i % 2 ? 'assistant' : 'user',
    timestamp: new Date(now - 3600000 + s * 1000).toISOString(),
  })).join('\n') + '\n');
}
mkT('-h-alpha/main1.jsonl', [0, 10, 20, 30]);                  // 30秒
mkT('-h-alpha/main1/subagents/agent-a.jsonl', [0, 10, 20]);    // 20秒(並列)
mkT('-h-beta/main2.jsonl', [0, 5, 500, 505]);                  // 5+5=10秒(間は空き)
mkT('-h-beta/single.jsonl', [0]);                              // 単発→除外

const { agents } = H.scan({ baseDir: base });
ok('main+subagentを両方拾う', agents.length === 3);
ok('★サブエージェントを識別', agents.filter((a) => a.isSubagent).length === 1);
ok('単発打刻のtranscriptは除外', !agents.some((a) => a.file.includes('single')));
const s = H.summarize(agents, 0, Date.now() + 1000);
ok('延べ稼働 = 30+20+10 = 60秒', Math.round(s.agentHours * 3600) === 60);
ok('★空きを跨いだ490秒は数えない(かさまし防止)', s.agentHours * 3600 < 100);

const BIN = path.join(__dirname, '..', 'bin', 'cchours.js');
const env = Object.assign({}, process.env, { CCHOURS_LANG: 'en' });
const run = (args, e) => execFileSync('node', [BIN, ...args, '--base-dir', base], { encoding: 'utf8', env: e || env });

const out = run(['--all']);
ok('CLI: 既定は日別テーブル', out.includes('agent-hrs') && out.includes('┌') && out.includes('Total'));
ok('CLI: メイン/サブの列', out.includes('main') && out.includes('subagents'));
const js = JSON.parse(run(['--all', '--json']));
ok('CLI: --json', typeof js.agentHours === 'number' && typeof js.personMonths === 'number');
ok('CLI: json も 60秒', Math.round(js.agentHours * 3600) === 60);
const ja = run(['--all'], Object.assign({}, env, { CCHOURS_LANG: 'ja' }));
ok('CLI: ja ロケール', ja.includes('延べ稼働') && ja.includes('サブ'));
const monthly = run(['--monthly']);
ok('CLI: --monthly は30日換算と人月/月', monthly.includes('per 30d') && monthly.includes('person-mo'));
ok('★CLI: --monthly は欠損の可能性を明記(誤読防止)', monthly.includes('cleanupPeriodDays'));
ok('★CLI: 人月の定義を明記', monthly.includes('Not a productivity claim'));
// カードは比較のためのものなので、既定は固定の30日窓(全期間ではない)
const card30 = run(['--card']);
ok('★CLI: --card の既定は直近30日(比較可能にする)', card30.includes('last 30 days'));
ok('★CLI: 履歴が窓より短ければ実データ量を明記', card30.includes('of history)'));
ok('CLI: --card --all は全期間に戻せる', /days? on disk/.test(run(['--card', '--all'])));

const cardOut = run(['--all', '--card']);
ok('CLI: --card はカードとnpx導線', cardOut.includes('cchours') && cardOut.includes('npx cchours'));
ok('CLI: --card はサブエージェント率を出す', cardOut.includes('subagents'));
const svgPath = path.join(tmp, 'card.svg');
run(['--all', '--svg', svgPath]);
ok('CLI: --svg がファイルを書く', fs.existsSync(svgPath) && fs.readFileSync(svgPath, 'utf8').startsWith('<svg'));
const caps = run(['--all', '--caps']);
ok('CLI: --caps は複数上限を並べる', caps.includes('30s') && caps.includes('900s'));
ok('★CLI: --caps は「唯一の正解ではない」と書く', /truth/.test(caps));
const proj = run(['--all', '--by-project']);
ok('CLI: --by-project', proj.includes('project') && proj.includes('alpha'));
const gap = JSON.parse(run(['--all', '--json', '--idle-gap', '600']));
ok('CLI: --idle-gap を上げると空きも稼働に含まれる', gap.agentHours * 3600 > 500);
const empty = execFileSync('node', [BIN, '--base-dir', path.join(tmp, 'nope')], { encoding: 'utf8', env });
ok('CLI: transcript無しでも落ちない', empty.includes('no transcripts'));

console.log('== scope (何を数えたか自分で名乗る) ==');
ok('CLI: 集計範囲を出す', out.includes('main loop + subagent turns'));
ok('CLI: ja でも集計範囲を出す', ja.includes('メインループ + サブエージェント'));
ok('CLI: --json に scope', js.scope === 'both');
ok('CLI: --monthly --json は配列のまま各行に scope',
  Array.isArray(JSON.parse(run(['--monthly', '--json']))) && JSON.parse(run(['--monthly', '--json']))[0].scope === 'both');
ok('★宣言したscopeと実装が一致(サブエージェント分が延べに入っている)',
  js.scope === 'both' && s.subagentHours > 0 && s.agentHours > s.mainHours);
ok('--by-project / --caps でも出す',
  proj.includes('main loop + subagent turns') && caps.includes('main loop + subagent turns'));

console.log('== day labels (local time, not UTC) ==');
// 08:00-08:10 in Tokyo on 2026-09-20 is 23:00Z on the 19th. Days are bucketed
// in local time, so the label must be the local day too.
const baseTz = path.join(tmp, 'tz', 'projects');
fs.mkdirSync(path.join(baseTz, '-p-a'), { recursive: true });
fs.writeFileSync(path.join(baseTz, '-p-a', 's.jsonl'), Array.from({ length: 20 }, (_, i) => JSON.stringify({
  type: i % 2 ? 'assistant' : 'user', timestamp: new Date(Date.parse('2026-09-19T23:00:00Z') + i * 30000).toISOString(),
})).join('\n') + '\n');
const envTokyo = Object.assign({}, env, { TZ: 'Asia/Tokyo' });
const runTz = (args) => execFileSync('node', [BIN, ...args, '--base-dir', baseTz], { encoding: 'utf8', env: envTokyo });
const tzDaily = JSON.parse(runTz(['--all', '--json']));
ok('★JST 08:00 の作業は当日(09-20)の行に出る(UTC の前日ではない)', tzDaily.daily.length === 1 && tzDaily.daily[0].date === '2026-09-20');
ok('★表の日付も当日', runTz(['--all']).includes('2026-09-20') && !runTz(['--all']).includes('2026-09-19'));
ok('★--card --json の day0 は窓の初日(ローカル)', JSON.parse(runTz(['--card', '--since', '20260920', '--json'])).day0 === '2026-09-20');

console.log('== bad flag values are refused, not read as "nothing" ==');
const code = (args) => { try { execFileSync('node', [BIN, ...args, '--base-dir', base], { encoding: 'utf8', env, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
ok('★--days abc は exit 2(全期間に化けない)', code(['--days', 'abc']) === 2);
ok('★--days -3 は exit 2', code(['--days', '-3']) === 2);
ok('★--idle-gap -5 は exit 2(0時間に化けない)', code(['--idle-gap', '-5']) === 2);
ok('★--since 2026-9-1 は exit 2(形式違いで全期間に化けない)', code(['--since', '2026-9-1']) === 2);
ok('★存在しない日付(2026-02-30)は exit 2', code(['--until', '20260230']) === 2);
ok('★--since が --until より後なら exit 2', code(['--since', '20260925', '--until', '20260901']) === 2);
ok('正しい値は通る', code(['--since', '2026-09-01', '--until', '20260925', '--days', '7', '--idle-gap', '120']) === 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
