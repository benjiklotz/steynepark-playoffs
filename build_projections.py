#!/usr/bin/env python3
"""Build projections.json for the playoff calculator.

Pulls Sleeper's weekly player projections for every remaining regular-season week, scores
them with the league's own scoring settings, and records NFL kickoff times (from ESPN's public
scoreboard) so the site can blend projections with live scores on game day. Also measures how
far actual lineup scores have landed from projections so far this season, which the site uses
as the spread when turning a projected margin into a win probability.

Standard library only. Run: python build_projections.py [league_id]
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

LEAGUE_ID = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("LEAGUE_ID")) or "1325795538116833280"
OUT = os.environ.get("OUT", "projections.json")
API = os.environ.get("SLEEPER_API", "https://api.sleeper.app")
POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"]
ESPN_TO_SLEEPER = {"WSH": "WAS"}
UA = {"User-Agent": "steynepark-playoffs/1.0 (+https://steyneparkleague.com)"}
BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Accept": "application/json"}


def get(url, retries=3, timeout=60, headers=None):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    print(f"warn: {url} failed: {last}", file=sys.stderr)
    return None


def score(stats, scoring):
    """Apply the league's scoring settings to a dict of raw stats."""
    if not stats:
        return 0.0
    total = 0.0
    for k, mult in scoring.items():
        v = stats.get(k)
        if v:
            total += float(v) * float(mult)
    return round(total, 2)


def fetch_projections(season, week):
    """Return {player_id: {"stats": {...}, "player": {...}}} for one week, trying both known endpoints."""
    out = {}
    q = "&".join(f"position[]={p}" for p in POSITIONS)
    data = get(f"{API}/projections/nfl/{season}/{week}?season_type=regular&{q}")
    if isinstance(data, list) and data:
        for e in data:
            pid = str(e.get("player_id") or "")
            if pid:
                out[pid] = {"stats": e.get("stats") or {}, "player": e.get("player") or {}}
        return out
    data = get(f"{API}/v1/projections/nfl/regular/{season}/{week}")
    if isinstance(data, dict) and data:
        for pid, stats in data.items():
            out[str(pid)] = {"stats": stats or {}, "player": {}}
    return out


_sleeper_schedule = None


def fetch_kickoffs(season, week):
    """{NFL team abbrev: kickoff}. Exact ISO timestamps from ESPN's public scoreboard where possible;
    otherwise Sleeper's schedule, which may only give the date (the site handles date-only safely)."""
    global _sleeper_schedule
    out = {}
    base = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
    for url in (f"{base}?seasontype=2&week={week}&dates={season}", f"{base}?seasontype=2&week={week}"):
        data = get(url, retries=2, headers=BROWSER_UA)
        if not isinstance(data, dict):
            continue
        for ev in data.get("events") or []:
            when = ev.get("date")
            if str((ev.get("season") or {}).get("year") or season) != str(season):
                continue
            for comp in ev.get("competitions") or []:
                for c in comp.get("competitors") or []:
                    ab = ((c.get("team") or {}).get("abbreviation") or "").upper()
                    if ab and when:
                        out[ESPN_TO_SLEEPER.get(ab, ab)] = when
        if out:
            return out, "espn"
    if _sleeper_schedule is None:
        _sleeper_schedule = get(f"{API}/schedule/nfl/regular/{season}") or []
    for g in _sleeper_schedule if isinstance(_sleeper_schedule, list) else []:
        if str(g.get("week")) != str(week):
            continue
        when = g.get("start_time") or g.get("kickoff") or g.get("date")
        if isinstance(when, (int, float)):
            when = datetime.fromtimestamp(when / (1000 if when > 1e11 else 1), tz=timezone.utc).isoformat(timespec="seconds")
        if not when:
            continue
        for key in ("home", "away", "home_team", "away_team"):
            ab = str(g.get(key) or "").upper()
            if ab:
                out[ab] = str(when)
    return out, "sleeper-schedule"


def main():
    league = get(f"{API}/v1/league/{LEAGUE_ID}")
    state = get(f"{API}/state/nfl") or get(f"{API}/v1/state/nfl")
    rosters = get(f"{API}/v1/league/{LEAGUE_ID}/rosters")
    if not league or not state or not rosters:
        sys.exit("could not load league/state/rosters from Sleeper")

    season = str(league.get("season") or state.get("season"))
    scoring = league.get("scoring_settings") or {}
    slots = [s for s in (league.get("roster_positions") or []) if s not in ("BN", "IR", "TAXI")]
    last_reg = int((league.get("settings") or {}).get("playoff_week_start") or 15) - 1
    if str(state.get("season")) != season or league.get("status") == "complete":
        cur = last_reg + 1
    elif state.get("season_type") == "pre":
        cur = 1
    elif state.get("season_type") == "post":
        cur = last_reg + 1
    else:
        cur = int(state.get("week") or state.get("display_week") or 1)
    print(f"season {season}, current week {cur}, regular season through week {last_reg}")

    rostered = set()
    for r in rosters:
        rostered.update(str(p) for p in (r.get("players") or []))

    players_all = None  # the 5MB player list, fetched only if projections lack player info

    def player_info(pid, entry):
        nonlocal players_all
        p = entry.get("player") or {}
        if not p.get("position"):
            if players_all is None:
                players_all = get(f"{API}/v1/players/nfl") or {}
            p = players_all.get(pid) or {}
        return {
            "name": (f"{p.get('first_name', '')} {p.get('last_name', '')}".strip() or pid),
            "pos": p.get("position") or "",
            "fp": p.get("fantasy_positions") or ([p.get("position")] if p.get("position") else []),
            "team": p.get("team") or "",
            "status": p.get("injury_status") or "",
        }

    players, proj, kickoffs = {}, {}, {}
    for week in range(cur, last_reg + 1):
        pw = fetch_projections(season, week)
        if not pw:
            print(f"week {week}: no projections", file=sys.stderr)
            continue
        wk = {}
        for pid in rostered:
            e = pw.get(pid)
            if e is None:
                continue  # bye week or not projected: counts as 0
            wk[pid] = score(e["stats"], scoring)
            if pid not in players:
                players[pid] = player_info(pid, e)
        proj[str(week)] = wk
        kick, src = fetch_kickoffs(season, week)
        if kick:
            kickoffs[str(week)] = kick
        exact = sum(1 for v in kick.values() if "T" in str(v))
        print(f"week {week}: {len(wk)} rostered players projected, {len(kick)} teams with kickoffs from {src} ({exact} with exact times)")
        time.sleep(0.3)

    # projection error so far this season: actual starter points vs projected, per team-week
    residuals = []
    for week in range(1, cur):
        pw = fetch_projections(season, week)
        mus = get(f"{API}/v1/league/{LEAGUE_ID}/matchups/{week}")
        if not pw or not mus:
            continue
        for m in mus:
            starters = [str(s) for s in (m.get("starters") or []) if s and str(s) != "0"]
            pts = m.get("players_points") or {}
            if not starters or not pts:
                continue
            actual = sum(float(pts.get(s, 0) or 0) for s in starters)
            expected = sum(score((pw.get(s) or {}).get("stats"), scoring) for s in starters)
            residuals.append(actual - expected)
        time.sleep(0.3)
    k, prior = 6, 20.0
    sigma = math.sqrt((sum(r * r for r in residuals) + k * prior * prior) / (len(residuals) + k))
    bias = (sum(residuals) / len(residuals)) if residuals else 0.0
    print(f"projection error: n={len(residuals)}, sd={sigma:.1f}, mean={bias:+.1f}")

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "league_id": str(LEAGUE_ID),
        "season": season,
        "current_week": cur,
        "slots": slots,
        "sigma": round(sigma, 2),
        "bias": round(bias, 2),
        "players": players,
        "proj": proj,
        "kickoffs": kickoffs,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}: weeks {sorted(proj)}")
    if not proj:
        sys.exit("no projections for any remaining week")


if __name__ == "__main__":
    main()
