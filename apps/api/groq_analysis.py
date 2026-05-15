# groq_analysis.py — All Groq/LLM calls for matchup analysis and slate summaries

import json
import os
import threading
from groq import Groq
try:
    from apps.api.nba_source import get_player_id_by_name, fetch_player_game_log
except ImportError:
    from nba_source import get_player_id_by_name, fetch_player_game_log

_client_lock = threading.Lock()
_client = None

def get_client() -> Groq:
    global _client
    with _client_lock:
        if _client is None:
            api_key = os.getenv("GROQ_API_KEY")
            if not api_key:
                raise ValueError("GROQ_API_KEY not set in environment")
            _client = Groq(api_key=api_key)
        return _client


MODEL = "llama-3.3-70b-versatile"


# ─────────────────────────────────────────────────────────────────────────────
# MATCHUP ANALYSIS
# ─────────────────────────────────────────────────────────────────────────────

def analyze_matchup(
    home_team: str,
    away_team: str,
    ml_probs: dict,
    home_stats: dict,
    away_stats: dict,
    home_injuries: dict | None = None,
    away_injuries: dict | None = None,
) -> dict:
    """
    Groq analyzes a single matchup and returns structured JSON with
    confidence, insight, expected margin, and risk factors.
    """
    injury_context = ""
    injured_player_summaries = []
    # List injured players and try to fetch recent game logs for context
    def _collect_injuries(team, injuries):
        s = ''
        if injuries and injuries.get('out_count', 0) > 0:
            out_players = injuries.get('out_players', [])
            s = f"\n{team} missing: {', '.join(out_players)}"
            for name in out_players:
                pid = get_player_id_by_name(name)
                if pid:
                    rows = fetch_player_game_log(pid)
                    if rows:
                        # compute simple averages across last 3 games
                        last = rows[:3]
                        pts = sum([r.get('PTS') or r.get('PTS', 0) for r in last]) / len(last)
                        ast = sum([r.get('AST') or 0 for r in last]) / len(last)
                        reb = sum([r.get('REB') or 0 for r in last]) / len(last)
                        injured_player_summaries.append(f"{name}: {pts:.1f} PTS, {reb:.1f} REB, {ast:.1f} AST (last {len(last)} games)")
        return s

    injury_context += _collect_injuries(home_team, home_injuries)
    injury_context += _collect_injuries(away_team, away_injuries)

    # Also collect top players recent form for each team (quick top-3)
    top_form_lines = []
    try:
        home_top = get_player_id_by_name  # placeholder to ensure import present
        from apps.api.nba_source import fetch_team_top_players
        ht = fetch_team_top_players(home_team, n=3)
        at = fetch_team_top_players(away_team, n=3)
        if ht:
            top_form_lines.append(f"Top {home_team}: " + "; ".join([f"{p['name']} {p['pts']:.1f} PTS/{p['reb']:.1f} REB/{p['ast']:.1f} AST" for p in ht]))
        if at:
            top_form_lines.append(f"Top {away_team}: " + "; ".join([f"{p['name']} {p['pts']:.1f} PTS/{p['reb']:.1f} REB/{p['ast']:.1f} AST" for p in at]))
    except Exception:
        top_form_lines = []

    prompt = f"""You are a senior NBA analyst. Analyze this matchup and return ONLY valid JSON — no markdown, no backticks, no preamble.

Game: {home_team} (home) vs {away_team} (away)

ML Model probabilities:
- {home_team} win: {ml_probs.get('home_win', 0.5):.1%}
- {away_team} win: {ml_probs.get('away_win', 0.5):.1%}

{home_team} recent form (last 10 games):
- Avg points: {home_stats.get('avg_PTS', 'N/A')}
- Net Rating: {home_stats.get('avg_NET_RTG', 'N/A')}
- eFG%: {home_stats.get('avg_eFG_PCT', 'N/A')}
- Win%: {home_stats.get('Form', 'N/A')}
- Streak: {home_stats.get('Streak', 0)}

{away_team} recent form (last 10 games):
- Avg points: {away_stats.get('avg_PTS', 'N/A')}
- Net Rating: {away_stats.get('avg_NET_RTG', 'N/A')}
- eFG%: {away_stats.get('avg_eFG_PCT', 'N/A')}
- Win%: {away_stats.get('Form', 'N/A')}
- Streak: {away_stats.get('Streak', 0)}

Injury context:{injury_context or ' None'}

Recent injured player form:
{('\n'.join(injured_player_summaries) if injured_player_summaries else ' None')}

Top player recent form:
{('\n'.join(top_form_lines) if top_form_lines else ' None')}

Return exactly this JSON:
{{
  "confidence": "high|medium|low",
  "predicted_winner": "{home_team}|{away_team}",
  "expected_margin": <integer, expected winning margin in points>,
  "key_insight": "<1-2 sentence analysis of the key factor in this game>",
  "home_strength": "<offense|defense|both|neither>",
  "away_strength": "<offense|defense|both|neither>",
  "upset_alert": <true|false>,
  "risk_factor": "<main risk to the predicted outcome in under 10 words>"
}}

IMPORTANT: Only use the data provided above. Do not add external facts, player stats, or information not included in this prompt."""

    try:
        resp = get_client().chat.completions.create(
            model=MODEL,
            max_tokens=400,
            temperature=0.3,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.choices[0].message.content.strip()
        start, end = raw.find("{"), raw.rfind("}") + 1
        if start == -1:
            raise ValueError("No JSON object in response")
        return json.loads(raw[start:end])
    except Exception as e:
        print(f"  [Groq] analyze_matchup failed: {e}")
        return {
            "confidence": "low",
            "predicted_winner": home_team if ml_probs.get("home_win", 0.5) > 0.5 else away_team,
            "expected_margin": 5,
            "key_insight": "Analysis unavailable — using ML model only.",
            "home_strength": "both",
            "away_strength": "both",
            "upset_alert": False,
            "risk_factor": "AI analysis unavailable",
        }


# ─────────────────────────────────────────────────────────────────────────────
# SLATE SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

def analyze_slate(games: list[dict]) -> dict:
    """
    Analyze all games on today's slate in a single Groq call.
    Returns best bets and a slate summary.
    """
    if not games:
        return {"summary": "No games today.", "best_bets": [], "top_pick": None}

    game_lines = []
    for i, g in enumerate(games, 1):
        b2b_note = ""
        if g.get("home_b2b"):
            b2b_note += f" [{g['home_team']} on B2B]"
        if g.get("away_b2b"):
            b2b_note += f" [{g['away_team']} on B2B]"
        game_lines.append(
            f"{i}. {g['home_team']} vs {g['away_team']} — "
            f"ML: {g['home_team']} {g['ml_probs']['home_win']:.0%} / "
            f"{g['away_team']} {g['ml_probs']['away_win']:.0%} | "
            f"ELO: {g.get('elo_home', 1500):.0f} vs {g.get('elo_away', 1500):.0f}"
            f"{b2b_note}"
        )

    games_text = "\n".join(game_lines)

    prompt = f"""You are an expert NBA analyst. Analyze today's NBA slate and return ONLY valid JSON — no markdown, no backticks.

Today's games:
{games_text}

Return exactly this JSON:
{{
  "summary": "<2-3 sentence overview of today's slate highlighting key storylines>",
  "best_bets": [
    {{
      "game": "<home_team> vs <away_team>",
      "pick": "<winning team>",
      "confidence": "high|medium|low",
      "stars": <1-3 integer>,
      "reason": "<under 15 words>"
    }}
  ],
  "top_pick": {{
    "game": "<home_team> vs <away_team>",
    "pick": "<winning team>",
    "one_liner": "<punchy 1-sentence reason>"
  }},
  "upset_watch": "<team most likely to pull an upset today or null>"
}}

Rules:
- best_bets: include only games where one team has clear ML edge (>58%). Max 3.
- Order best_bets by confidence descending.
- Be concise and direct — no hedging.
- IMPORTANT: Only use the data provided above. Do not add external facts or information not included in this prompt."""

    try:
        resp = get_client().chat.completions.create(
            model=MODEL,
            max_tokens=800,
            temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.choices[0].message.content.strip()
        start, end = raw.find("{"), raw.rfind("}") + 1
        if start == -1:
            raise ValueError("No JSON in response")
        return json.loads(raw[start:end])
    except Exception as e:
        print(f"  [Groq] analyze_slate failed: {e}")
        return {
            "summary": "Slate analysis unavailable.",
            "best_bets": [],
            "top_pick": None,
            "upset_watch": None,
        }


# ─────────────────────────────────────────────────────────────────────────────
# DIVERGENCE ANALYSIS (when Polymarket differs from ML)
# ─────────────────────────────────────────────────────────────────────────────

def analyze_divergence(
    home_team: str,
    away_team: str,
    ml_probs: dict,
    polymarket_probs: dict,
    poly_liquidity: float,
) -> str:
    """
    Short natural-language explanation of why Polymarket and ML disagree.
    """
    home_diff = ml_probs.get("home_win", 0.5) - polymarket_probs.get("home_win", 0.5)
    direction = (
        f"ML favors {home_team} more than the market"
        if home_diff > 0
        else f"Market favors {home_team} more than ML"
    )

    prompt = f"""NBA game: {home_team} (home) vs {away_team} (away).

ML model: {home_team} {ml_probs.get('home_win', 0.5):.1%} | {away_team} {ml_probs.get('away_win', 0.5):.1%}
Polymarket: {home_team} {polymarket_probs.get('home_win', 0.5):.1%} | {away_team} {polymarket_probs.get('away_win', 0.5):.1%}
Polymarket liquidity: ${poly_liquidity:,.0f}
Direction: {direction} by {abs(home_diff):.1%}

In 2-3 sentences: Why might the market and the model disagree here? Consider injury news, lineup changes, load management, travel, or crowd wisdom. Be specific and direct."""

    try:
        resp = get_client().chat.completions.create(
            model=MODEL,
            max_tokens=200,
            temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"  [Groq] analyze_divergence failed: {e}")
        return f"{direction} by {abs(home_diff):.1%}. Divergence analysis unavailable."
