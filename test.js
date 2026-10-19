// Runs against the engine embedded in index.html (same folder): node test.js
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])();
const E = globalThis.Engine;
const assert = require('assert');

// ---- synthetic 12-team, 3-division league, 14-week schedule ----
function makeLeague(lockedWeeks, seed = 1) {
  let rs = seed; const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const teams = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: 'T' + i, owner: 'o' + i, div: Math.floor(i / 4) + 1 }));
  // circle-method round robin (11 weeks, every pair once) + 3 weeks of in-division round robin
  const weeks = [];
  const arr = Array.from({ length: 12 }, (_, i) => i);
  for (let w = 1; w <= 11; w++) {
    const games = [];
    for (let k = 0; k < 6; k++) { const a = arr[k], b = arr[11 - k]; games.push(a < b ? { a, b } : { a: b, b: a }); }
    weeks.push({ week: w, games });
    arr.splice(1, 0, arr.pop());
  }
  const divRR = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  divRR.forEach((pairs, k) => {
    const games = [];
    for (let d = 0; d < 3; d++) pairs.forEach(([x, y]) => games.push({ a: 4 * d + x, b: 4 * d + y }));
    weeks.push({ week: 12 + k, games });
  });
  const mu = teams.map((_, i) => 100 + i * 2.5);
  weeks.forEach(wk => {
    wk.locked = wk.week <= lockedWeeks;
    wk.scores = {};
    if (wk.locked) {
      for (let i = 0; i < 12; i++) wk.scores[i] = +(mu[i] + (rnd() - 0.5) * 60).toFixed(2);
      wk.games.forEach(g => { g.pa = wk.scores[g.a]; g.pb = wk.scores[g.b]; });
    }
  });
  return { teams, divs: { 1: 'East', 2: 'West', 3: 'North' }, weeks, nTeams: 12 };
}

// ---- 1. schedule sanity ----
const L = makeLeague(9);
let cnt = {};
L.weeks.forEach(w => w.games.forEach(g => { const k = g.a + '-' + g.b; cnt[k] = (cnt[k] || 0) + 1; }));
assert.strictEqual(Object.keys(cnt).length, 66);
assert.strictEqual(Object.values(cnt).reduce((a, b) => a + b), 84);

// ---- 2. base build & fair play totals ----
const base = E.buildBase(L);
const totalFP = base.state.fp.reduce((a, b) => a + b);
assert.ok(Math.abs(totalFP - 9 * 66) < 1e-6, 'all-play wins per week sum to C(12,2)');
assert.ok(base.sd > 0);
console.log('base ok; locked', base.lockedWeeks, 'sd', base.sd.toFixed(1));

// ---- 3. hand-built tiebreak cases ----
function st(n = 4) { const s = E.buildBase({ teams: Array.from({ length: n }, (_, i) => ({ div: 1 })), weeks: [], nTeams: n }).state; return s; }
const miniL = { teams: [{ name: 'A', div: 1 }, { name: 'B', div: 1 }, { name: 'C', div: 1 }, { name: 'D', div: 1 }], nTeams: 4 };
function rec(s, i, w, l) { s.w[i] = w; s.l[i] = l; }

// 3a. three-way tie, A swept B and C -> A
{
  const s = st(); [0, 1, 2].forEach(i => rec(s, i, 8, 6)); rec(s, 3, 2, 12);
  s.hw[0][1] = 2; s.hw[0][2] = 2; s.hw[1][2] = 1; s.hw[2][1] = 1;
  const r = E.resolveSeed([0, 1, 2, 3], s, E.STEPS.division, miniL);
  assert.strictEqual(r.winner, 0); console.log('3a', r.log);
}
// 3b. three-way tie, C lost all to A and B -> C eliminated, then A v B 1-1 -> div record decides (A better)
{
  const s = st(); [0, 1, 2].forEach(i => rec(s, i, 8, 6)); rec(s, 3, 2, 12);
  s.hw[0][1] = 1; s.hw[1][0] = 1; s.hw[0][2] = 2; s.hw[1][2] = 2;
  s.dw[0] = 4; s.dl[0] = 2; s.dw[1] = 3; s.dl[1] = 3; s.dw[2] = 1; s.dl[2] = 5;
  const r = E.resolveSeed([0, 1, 2, 3], s, E.STEPS.division, miniL);
  assert.strictEqual(r.winner, 0); console.log('3b', r.log);
}
// 3c. 1-1 split does NOT count; equal div record -> fair play eliminates lowest -> B
{
  const s = st(); rec(s, 0, 8, 6); rec(s, 1, 8, 6); rec(s, 2, 5, 9); rec(s, 3, 5, 9);
  s.hw[0][1] = 1; s.hw[1][0] = 1; s.dw[0] = s.dw[1] = 3; s.dl[0] = s.dl[1] = 3;
  s.fp[0] = 60; s.fp[1] = 70;
  const r = E.resolveSeed([0, 1, 2, 3], s, E.STEPS.division, miniL);
  assert.strictEqual(r.winner, 1); console.log('3c', r.log);
}
// 3d. wildcard: A beat B once (only meeting), B beat C, C and A haven't played -> no sweep -> fair play: lowest out (C), restart: A beat B -> A
{
  const s = st(); [0, 1, 2].forEach(i => rec(s, i, 7, 7));
  s.hw[0][1] = 1; s.hw[1][2] = 1; s.fp[0] = 50; s.fp[1] = 55; s.fp[2] = 40;
  const r = E.resolveSeed([0, 1, 2], s, E.STEPS.wildcard, miniL);
  assert.strictEqual(r.winner, 0); console.log('3d', r.log);
}
// 3g. three-way: A 4-2, B 4-2, C 3-3 -> C eliminated (not on best), restart A v B: A beat B twice -> A
{
  const s = st(); [0, 1, 2].forEach(i => rec(s, i, 8, 6)); rec(s, 3, 2, 12);
  s.hw[0][1] = 2; s.hw[0][2] = 1; s.hw[2][0] = 1; s.hw[1][2] = 1; s.hw[2][1] = 1;
  s.dw[0] = 4; s.dl[0] = 2; s.dw[1] = 4; s.dl[1] = 2; s.dw[2] = 3; s.dl[2] = 3;
  const r = E.resolveSeed([0, 1, 2, 3], s, E.STEPS.division, miniL);
  assert.strictEqual(r.winner, 0); assert.ok(r.log.some(l => l.includes('C eliminated'))); console.log('3g', r.log);
}
// 3h. three-way: A 4-2, B 3-3, C 2-4 -> B and C both eliminated at once -> A
{
  const s = st(); [0, 1, 2].forEach(i => rec(s, i, 8, 6)); rec(s, 3, 2, 12);
  s.hw[0][1] = 1; s.hw[1][0] = 1; s.hw[0][2] = 1; s.hw[2][0] = 1; s.hw[1][2] = 1; s.hw[2][1] = 1;
  s.dw[0] = 4; s.dl[0] = 2; s.dw[1] = 3; s.dl[1] = 3; s.dw[2] = 2; s.dl[2] = 4;
  const r = E.resolveSeed([0, 1, 2, 3], s, E.STEPS.division, miniL);
  assert.strictEqual(r.winner, 0); assert.ok(r.log.some(l => l.includes('B, C eliminated'))); console.log('3h', r.log);
}
// 3e. fair play tie all the way -> points for
{
  const s = st(); rec(s, 0, 7, 7); rec(s, 1, 7, 7); s.hw[0][1] = 1; s.hw[1][0] = 1; s.fp[0] = s.fp[1] = 50; s.pf[0] = 1500; s.pf[1] = 1600;
  const r = E.resolveSeed([0, 1], s, E.STEPS.wildcard, miniL);
  assert.strictEqual(r.winner, 1); console.log('3e', r.log);
}
// 3f. unplayed H2H in wildcard means no sweep
{
  const s = st(); rec(s, 0, 7, 7); rec(s, 1, 7, 7); s.fp[0] = 40; s.fp[1] = 50;
  const r = E.resolveSeed([0, 1], s, E.STEPS.wildcard, miniL);
  assert.strictEqual(r.winner, 1); assert.ok(r.log[1].includes('not played')); console.log('3f', r.log);
}

// ---- 4. full seeding on synthetic league, scenario with picks ----
const picks = {};
E.remainingGames(L).forEach((g, i) => { picks[g.key] = (i % 3 === 0) ? 0 : (i % 2 ? 1 : 2); });
const sc = E.buildScenario(L, base, picks, { fp: { 0: 30 } });
const seeding = E.seedPlayoffs(L, sc.state);
assert.strictEqual(seeding.seeds.length, 6);
assert.strictEqual(new Set(seeding.seeds.map(x => x.team)).size, 6);
console.log('seeds', seeding.seeds.map(x => `${x.seed}:${L.teams[x.team].name}`).join(' '), 'unpicked', sc.unpicked);
seeding.seeds.forEach(x => x.log.forEach(l => console.log('  ', x.seed, l)));

// ---- 5. simulation smoke ----
const t0 = Date.now();
const sim = E.simulate(L, base, picks, {}, 2000, 3);
console.log('sim ms', Date.now() - t0);
const sumP = sim.reduce((a, b) => a + b.playoffs, 0);
assert.ok(Math.abs(sumP - 6) < 1e-6, 'six playoff spots');
assert.ok(Math.abs(sim.reduce((a, b) => a + b.div, 0) - 3) < 1e-6);
console.log(sim.map((x, i) => `${L.teams[i].name} ${(x.playoffs * 100).toFixed(0)}%`).join(' '));

// ---- 6. share link round trip ----
const h = E.encodeScenario(L, picks, { fp: { 0: 30 }, pf: {} });
const d = E.decodeScenario(L, '#' + h);
assert.deepStrictEqual(Object.fromEntries(Object.entries(picks).filter(([, v]) => v)), d.picks);
assert.strictEqual(d.overrides.fp[0], 30);
console.log('link', h.length, 'chars');
console.log('ALL TESTS PASSED');

// ---- 7. optimal lineup ----
{
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
  const P = { qb1: ['QB'], qb2: ['QB'], rb1: ['RB'], rb2: ['RB'], rb3: ['RB'], wr1: ['WR'], wr2: ['WR'], wr3: ['WR'], te1: ['TE'], k1: ['K'], d1: ['DEF'], bye: ['WR'] };
  const pr = { qb1: 20, qb2: 22, rb1: 15, rb2: 12, rb3: 14, wr1: 18, wr2: 9, wr3: 11, te1: 8, k1: 7, d1: 6, bye: 0 };
  const r = E.optimalLineup(slots, Object.keys(P), p => pr[p], p => P[p]);
  const ids = r.starters.map(s => s.pid).sort().join(',');
  assert.strictEqual(ids, 'd1,k1,qb2,rb1,rb3,rb2,te1,wr1,wr3'.split(',').sort().join(','));
  assert.strictEqual(r.total, 22 + 15 + 14 + 18 + 11 + 8 + 12 + 7 + 6);
  assert.strictEqual(r.starters.find(s => s.slot === 'FLEX').pid, 'rb2');
  console.log('7 lineup ok', r.total);
}

// ---- 8. week models: future week uses optimal lineup; live week blends scores ----
{
  const L2 = makeLeague(9);
  L2.slots = ['QB', 'RB', 'WR', 'FLEX'];
  const players = {};
  L2.teams.forEach((t, i) => { t.players = ['q' + i, 'r' + i, 'w' + i, 'x' + i]; players['q' + i] = { fp: ['QB'], team: 'T' + i }; players['r' + i] = { fp: ['RB'], team: 'T' + i }; players['w' + i] = { fp: ['WR'], team: 'T' + i }; players['x' + i] = { fp: ['WR'], team: 'B' + i }; });
  const proj = {}, kickoffs = {};
  const now = Date.parse('2026-10-19T02:00:00Z');
  for (const wk of L2.weeks) { if (wk.locked) continue; proj[wk.week] = {}; kickoffs[wk.week] = {}; L2.teams.forEach((t, i) => { proj[wk.week]['q' + i] = 20 + i; proj[wk.week]['r' + i] = 10; proj[wk.week]['w' + i] = 12; proj[wk.week]['x' + i] = 8; }); }
  // week 10: team 0's players finished (kickoff 5h ago), team 1 in progress (1h ago), others not started
  kickoffs[10] = { T0: '2026-10-18T21:00:00Z', T1: '2026-10-19T01:00:00Z', T2: '2026-10-19T08:00:00Z' };
  L2.weeks.find(w => w.week === 10).lineups = { 0: { starters: ['q0', 'r0', 'w0', 'x0'], pts: { q0: 30, r0: 5, w0: 10, x0: 4 } }, 1: { starters: ['q1', 'r1', 'w1', 'x1'], pts: { q1: 15, r1: 3, w1: 6, x1: 0 } } };
  const B2 = E.buildBase(L2);
  const M = E.buildWeekModels(L2, B2, { sigma: 20, bias: 0, players, proj, kickoffs }, now, 10);
  assert.ok(M[10].live && !M[11].live);
  // team 0 finished: mean = actual (49), sd 0 except x0 (team B0 no kickoff -> still projected 8)
  assert.ok(Math.abs(M[10].mu[0] - (30 + 5 + 10 + 8)) < 1e-9, 'finished players locked');
  // team 1: 1h into a 3.25h game -> r = 1 - 1/3.25
  const r = 1 - 1 / 3.25;
  assert.ok(Math.abs(M[10].mu[1] - (15 + 3 + 6 + (21 + 10 + 12) * r + 8)) < 1e-9, 'in-progress blend');
  assert.ok(M[10].sd[1] < M[10].sd[5] && M[10].sd[0] < M[10].sd[1], 'spread shrinks as games finish');
  // future week 11: optimal lineup = q + r + best wr + flex(other wr)
  assert.ok(Math.abs(M[11].mu[3] - ((23 + 10 + 12 + 8) * 0.9 + 0.1 * B2.model[3].mu)) < 1e-9, 'future week blend');
  const p = E.winProb(B2, 0, 1, M[10]);
  assert.ok(p > 0 && p < 0.5, 'live win prob sensible (team 1 projects higher)');
  const sim2 = E.simulate(L2, B2, {}, {}, 300, 3, M);
  assert.ok(Math.abs(sim2.reduce((x, y) => x + y.playoffs, 0) - 6) < 1e-6);
  console.log('8 week models ok', M[10].mu.slice(0, 3).map(x => x.toFixed(1)), M[10].sd.slice(0, 3).map(x => x.toFixed(1)));
}
console.log('PROJECTION TESTS PASSED');

// ---- 9. date-only kickoffs (Sleeper schedule fallback) must not mark unplayed games final ----
{
  const L3 = makeLeague(5);
  L3.slots = ['QB', 'RB'];
  const players = {}; const proj = {}; const kickoffs = {};
  L3.teams.forEach((t, i) => { t.players = ['q' + i, 'r' + i]; players['q' + i] = { fp: ['QB'], team: i < 2 ? 'THU' : 'SUN' }; players['r' + i] = { fp: ['RB'], team: 'SUN' }; });
  L3.weeks.filter(w => !w.locked).forEach(w => { proj[w.week] = {}; L3.teams.forEach((t, i) => { proj[w.week]['q' + i] = 20; proj[w.week]['r' + i] = 10; }); });
  kickoffs[6] = { THU: '2026-10-15', SUN: '2026-10-18' };
  L3.weeks.find(w => w.week === 6).lineups = { 0: { starters: ['q0', 'r0'], pts: { q0: 31 } }, 1: { starters: ['q1', 'r1'], pts: { q1: 4 } } };
  const B3 = E.buildBase(L3);
  const P3 = { sigma: 20, bias: 0, players, proj, kickoffs };
  // Sunday 21:42 Sydney = 10:42 UTC: Thursday game over, Sunday games not started
  let M = E.buildWeekModels(L3, B3, P3, Date.parse('2026-10-18T10:42:00Z'), 6);
  assert.ok(M[6].live);
  assert.strictEqual(M[6].detail[0].done, 1); assert.strictEqual(M[6].detail[0].n, 2);
  assert.ok(Math.abs(M[6].mu[0] - (31 + 10)) < 1e-9, 'Thursday actual + Sunday projection');
  assert.ok(Math.abs(M[6].mu[1] - (4 + 10)) < 1e-9);
  assert.ok(Math.abs(M[6].mu[2] - 30) < 1e-9 && M[6].detail[2].done === 0 && M[6].detail[2].started === 0, 'unplayed team not final');
  // Sunday 20:00 UTC (games under way, time unknown): projection kept until outscored
  L3.weeks.find(w => w.week === 6).lineups[2] = { starters: ['q2', 'r2'], pts: { q2: 25, r2: 3 } };
  M = E.buildWeekModels(L3, B3, P3, Date.parse('2026-10-18T20:00:00Z'), 6);
  assert.ok(Math.abs(M[6].mu[2] - (25 + 10)) < 1e-9 && M[6].detail[2].done === 0, 'in-window: max(points, projection)');
  // Tuesday 09:00 UTC: everything on the Sunday date is final
  M = E.buildWeekModels(L3, B3, P3, Date.parse('2026-10-20T09:00:00Z'), 6);
  assert.ok(Math.abs(M[6].mu[2] - 28) < 1e-9 && M[6].detail[2].done === 2 && M[6].sd[2] === 0, 'all final after the day');
  console.log('9 date-only kickoffs ok');
}
console.log('DATE-ONLY TESTS PASSED');

// ---- 10. average finish: every position 1-12 used once per sim, so averages sum to 78 ----
{
  const s10 = E.simulate(L, base, {}, {}, 2000, 3);
  const tot = s10.reduce((x, y) => x + y.avgFinish, 0);
  assert.ok(Math.abs(tot - 78) < 1e-6, 'finishes sum to 1+...+12');
  s10.forEach(t => assert.ok(t.avgFinish >= 1 && t.avgFinish <= 12));
  // a near-certain playoff team should finish ahead, on average, of a near-certain miss
  const hi = s10.reduce((b, t, i) => t.playoffs > s10[b].playoffs ? i : b, 0), lo = s10.reduce((b, t, i) => t.playoffs < s10[b].playoffs ? i : b, 0);
  assert.ok(s10[hi].avgFinish < s10[lo].avgFinish);
  console.log('10 avg finish ok', s10.map(t => t.avgFinish.toFixed(1)).join(' '));
}
console.log('AVG FINISH TESTS PASSED');

// ---- 11. fair play orders ----
{
  const L4 = makeLeague(9);
  const B4 = E.buildBase(L4);
  const wk = L4.weeks.find(w => !w.locked); const week = wk.week;
  // default follows season mu (no models): team 11 highest
  const d0 = E.defaultFpOrder(L4, B4, null, week, {});
  assert.strictEqual(d0[0], 11); assert.strictEqual(d0[11], 0);
  // pick an upset: lowest team beats highest in their game (if they play) else use first game
  const g = wk.games[0]; const key = `${week}:0`;
  const hi = B4.model[g.a].mu > B4.model[g.b].mu ? g.a : g.b, lo = hi === g.a ? g.b : g.a;
  const picks4 = { [key]: lo === g.a ? 1 : 2 };
  const d1 = E.defaultFpOrder(L4, B4, null, week, picks4);
  assert.ok(d1.indexOf(lo) < d1.indexOf(hi), 'winner moved above loser');
  assert.strictEqual(d1.indexOf(hi), d1.indexOf(lo) + 1, 'adjacent at the midpoint');
  const mid = Math.floor((d0.indexOf(lo) + d0.indexOf(hi)) / 2);
  assert.strictEqual(d1.indexOf(lo), mid, 'placed at midpoint of former positions');
  assert.strictEqual(new Set(d1).size, 12);
  // fpFromOrder + picksFromOrder
  const fp = E.fpFromOrder(d1, 12); assert.strictEqual(fp[d1[0]], 11); assert.strictEqual(fp[d1[11]], 0);
  const ip = E.picksFromOrder(L4, week, d1); assert.strictEqual(ip[key], picks4[key]);
  // scenario uses order for picked teams only
  const ords = E.effectiveFpOrders(L4, B4, null, picks4, {});
  const sc4 = E.buildScenario(L4, B4, picks4, {}, ords);
  assert.ok(Math.abs(sc4.state.fp[lo] - B4.state.fp[lo] - (11 - d1.indexOf(lo))) < 1e-9, 'picked winner gets order FP');
  const other = d1.find(t => t !== lo && t !== hi);
  assert.ok(Math.abs(sc4.state.fp[other] - B4.state.fp[other]) < 1e-9, 'unpicked team gets nothing');
  // user order reconciles with a later contradictory pick
  const user = d0.slice(); const p2 = { [key]: hi === g.a ? 1 : 2 };
  const ords2 = E.effectiveFpOrders(L4, B4, null, p2, { [week]: user });
  assert.ok(ords2[week].indexOf(hi) < ords2[week].indexOf(lo));
  // share-link round trip with orders
  const enc = E.encodeScenario(L4, picks4, { fp: {}, pf: {} }, { [week]: d1 });
  const dec = E.decodeScenario(L4, '#' + enc);
  assert.deepStrictEqual(dec.fpOrders[week], d1);
  // simulate with fixed FP for the week
  const s4 = E.simulate(L4, B4, picks4, {}, 300, 3, null, { fpFixed: { [week]: fp }, seed: 7 });
  assert.ok(Math.abs(s4.reduce((x, y) => x + y.playoffs, 0) - 6) < 1e-6);
  // seeded runs are reproducible
  const r1 = E.simulate(L4, B4, {}, {}, 500, 3, null, { seed: 42 }), r2 = E.simulate(L4, B4, {}, {}, 500, 3, null, { seed: 42 });
  assert.deepStrictEqual(r1, r2);
  console.log('11 fair play orders ok');
}

// ---- 12. positions 7-12 by tiebreakers, history points ----
{
  const sd = E.seedPlayoffs(L, base.state);
  assert.strictEqual(sd.out.length, 6); assert.strictEqual(sd.outLog.length, 6);
  assert.deepStrictEqual(sd.outLog.map(x => x.pos), [7, 8, 9, 10, 11, 12]);
  assert.strictEqual(new Set([...sd.seeds.map(x => x.team), ...sd.out]).size, 12);
  // records never increase down the list
  const recs = sd.out.map(i => E.pct(base.state.w[i], base.state.l[i], base.state.t[i]));
  for (let k = 1; k < recs.length; k++) assert.ok(recs[k] <= recs[k - 1] + 1e-9);
  const h5 = E.historyPoint(L, 5, 300), h9 = E.historyPoint(L, 9, 300);
  assert.strictEqual(new Set(h5.finish).size, 12); assert.ok(h5.finish.every(f => f >= 1 && f <= 12));
  const L5 = E.leagueAfterWeek(L, 5);
  assert.strictEqual(L5.weeks.filter(w => w.locked).length, 5);
  assert.ok(L5.weeks.find(w => w.week === 7).games.every(g => g.pa === 0));
  assert.ok(Math.abs(h9.odds.reduce((x, y) => x + y.playoffs, 0) - 6) < 1e-6);
  const again = E.historyPoint(L, 5, 300); assert.deepStrictEqual(again.odds, h5.odds);
  console.log('12 ranking + history ok', h9.finish.join(' '));
}
console.log('ORDER AND HISTORY TESTS PASSED');
