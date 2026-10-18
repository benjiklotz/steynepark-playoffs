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
