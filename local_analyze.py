"""
local_analyze.py — Run Claude AI analysis on local donor data.
Run: .venv/bin/python3 local_analyze.py

Reads donors from frontend/public/sample-data/donors/latest.json,
scores every donor with Claude (RFM, lapse risk, upgrade propensity,
ask amount, donor portrait), and writes results back to the same file.

Requires ANTHROPIC_API_KEY in .env
"""

import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Load .env
def load_dotenv():
    env_file = Path(__file__).parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

load_dotenv()

import anthropic

DATA_FILE  = Path(__file__).parent / "frontend/public/sample-data/donors/latest.json"
BATCH_SIZE = 10
MODEL      = "claude-haiku-4-5-20251001"   # fast + cheap for batch scoring


def days_since(date_str):
    if not date_str:
        return None
    try:
        d = datetime.fromisoformat(str(date_str).replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - d).days
    except Exception:
        return None


def build_prompt(summaries):
    return f"""You are a nonprofit fundraising analyst for Water4.org, which builds clean water infrastructure in developing countries (Ethiopia, Nigeria, Uganda, Kenya, and others).

Analyze these {len(summaries)} donors and return scores as JSON.

Donor data:
{json.dumps(summaries, indent=2)}

Water4 Giving Tiers (annual):
- Transformational: $100,000+
- Leadership: $25,000–$99,999
- Major: $10,000–$24,999
- Mid-Level: $5,000–$9,999
- Donor: $1,000–$4,999
- Friend: $1–$999

For EACH donor return:
- rfm_recency: 1-5 (5=gave in last 90 days, 4=91-180d, 3=181-365d, 2=1-2yr, 1=2yr+)
- rfm_frequency: 1-5 (5=10+ gifts, 4=6-9, 3=3-5, 2=2, 1=1)
- rfm_monetary: 1-5 (5=Transformational, 4=Leadership, 3=Major, 2=Mid-Level, 1=Friend/Donor)
- upgrade_propensity: 0.0–1.0 (likelihood to upgrade tier this year)
- lapse_risk: 0.0–1.0 (likelihood to NOT give this year; max 0.25 for active recurring donors)
- ai_score: 0-100 composite (weighted: recency 40%, monetary 35%, frequency 25%)
- ask_amount: recommended next ask in whole dollars (never below last gift; aim for next tier × 0.85 if upgrade candidate)
- ask_rationale: 1 sentence
- ai_narrative: 2-3 sentences for the gift officer — specific, warm, actionable

Return ONLY valid JSON, no markdown:
{{"sf_id_1": {{"rfm_recency":4,"rfm_frequency":3,"rfm_monetary":2,"upgrade_propensity":0.65,"lapse_risk":0.15,"ai_score":72,"ask_amount":2500,"ask_rationale":"...","ai_narrative":"...","last_analyzed":"YYYY-MM-DD"}}, ...}}"""


def parse_response(raw, donors, now_str):
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    try:
        parsed = json.loads(text)
        for sf_id in parsed:
            parsed[sf_id]["last_analyzed"] = now_str
        return parsed
    except Exception as e:
        print(f"  ⚠ Parse error: {e} — using fallback scores for this batch")
        return {}


def fallback_score(d, now_str):
    """Rule-based fallback when Claude parsing fails."""
    total   = float(d.get("total_giving") or 0)
    this_fy = float(d.get("giving_this_fy") or 0)
    last_fy = float(d.get("giving_last_fy") or 0)
    count   = int(d.get("gift_count") or 0)
    is_rd   = bool(d.get("is_recurring"))
    ds      = days_since(d.get("last_gift_date"))

    r = 5 if ds and ds<=90 else 4 if ds and ds<=180 else 3 if ds and ds<=365 else 2 if ds and ds<=730 else 1
    f = 5 if count>=10 else 4 if count>=6 else 3 if count>=3 else 2 if count>=2 else 1
    m = 5 if total>=100000 else 4 if total>=25000 else 3 if total>=10000 else 2 if total>=5000 else 1

    lapse = 0.15 if is_rd else (0.7 if r<=2 else 0.45 if r==3 else 0.2)
    if this_fy == 0 and last_fy > 0:
        lapse = min(0.9, lapse + 0.25)

    tiers = [1000, 5000, 10000, 25000, 100000]
    best  = max(this_fy, last_fy)
    next_t = next((t for t in tiers if t > best), 100000)
    ask   = int(max(next_t * 0.85, (d.get("last_gift_amount") or 0) * 1.1, 500))

    return {
        "rfm_recency": r, "rfm_frequency": f, "rfm_monetary": m,
        "upgrade_propensity": round(min(0.9, (best / next_t) if next_t else 0.3), 2),
        "lapse_risk": round(lapse, 2),
        "ai_score": int((r*0.4 + m*0.35 + f*0.25) / 5 * 100),
        "ask_amount": ask,
        "ask_rationale": "Based on giving history and tier proximity.",
        "ai_narrative": f"{d.get('full_name','This donor')} has given ${total:,.0f} lifetime across {count} gifts.",
        "last_analyzed": now_str,
    }


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("❌ ANTHROPIC_API_KEY not set in .env")
        sys.exit(1)

    print("=== Water4 FIS — Claude Analysis ===\n")

    donors = json.loads(DATA_FILE.read_text())
    print(f"Loaded {len(donors)} donors from {DATA_FILE.name}")

    # Only analyze donors not analyzed in last 7 days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    stale  = [d for d in donors if not d.get("last_analyzed") or d["last_analyzed"] < cutoff]
    print(f"{len(stale)} donors need analysis ({len(donors)-len(stale)} already current)\n")

    if not stale:
        print("All donors are up to date — nothing to do.")
        return

    # Confirm before spending API credits
    est_batches = (len(stale) + BATCH_SIZE - 1) // BATCH_SIZE
    est_cost    = est_batches * 0.003  # rough estimate ~$0.003/batch for Haiku
    print(f"Will analyze {len(stale)} donors in {est_batches} batches (~${est_cost:.2f} estimated)")
    try:
        confirm = input("Proceed? [Y/n]: ").strip().lower()
    except EOFError:
        confirm = "y"
    if confirm == "n":
        print("Aborted.")
        return

    client   = anthropic.Anthropic(api_key=api_key)
    now_str  = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    donor_map = {d["sf_id"]: d for d in donors}

    total_scored = 0
    errors       = 0
    start        = time.time()

    for i in range(0, len(stale), BATCH_SIZE):
        batch     = stale[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{est_batches} ({len(batch)} donors)...", end=" ", flush=True)

        # Build compact summaries
        summaries = []
        for d in batch:
            summaries.append({
                "sf_id":            d["sf_id"],
                "name":             d.get("full_name", ""),
                "total_giving":     d.get("total_giving", 0),
                "giving_this_fy":   d.get("giving_this_fy", 0),
                "giving_last_fy":   d.get("giving_last_fy", 0),
                "last_gift_amount": d.get("last_gift_amount", 0),
                "last_gift_days_ago": days_since(d.get("last_gift_date")),
                "gift_count":       d.get("gift_count", 0),
                "is_recurring":     d.get("is_recurring", False),
                "rd_amount":        d.get("rd_amount", 0),
                "rd_period":        d.get("rd_period", ""),
            })

        try:
            msg  = client.messages.create(
                model=MODEL,
                max_tokens=8192,
                messages=[{"role": "user", "content": build_prompt(summaries)}],
            )
            results = parse_response(msg.content[0].text, batch, now_str)

            # Merge back
            for d in batch:
                sf_id    = d["sf_id"]
                analysis = results.get(sf_id) or fallback_score(d, now_str)
                donor_map[sf_id].update(analysis)
                total_scored += 1

            print(f"✓ ({msg.usage.input_tokens}→{msg.usage.output_tokens} tokens)")

        except Exception as e:
            print(f"✗ Error: {e}")
            # Apply fallback scores so we don't leave batch unscored
            for d in batch:
                donor_map[d["sf_id"]].update(fallback_score(d, now_str))
            errors += 1

    # Write updated donors back to file
    updated = list(donor_map.values())
    DATA_FILE.write_text(json.dumps(updated, indent=2, default=str))

    elapsed = round(time.time() - start, 1)
    print(f"\n✅ Analysis complete in {elapsed}s")
    print(f"   {total_scored} donors scored | {errors} batch errors")
    print(f"\nRefresh http://localhost:5173/water4-fis/ to see AI scores, narratives, and ask amounts.")


if __name__ == "__main__":
    main()
