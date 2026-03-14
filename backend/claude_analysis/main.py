"""
claude_analysis/main.py — Cloud Function: Claude AI analysis of donors & campaigns.

Trigger: Cloud Scheduler (nightly after sf_sync), or HTTP for on-demand refresh
Entry points:
  analyze_batch    — process all donors/campaigns needing fresh analysis
  analyze_donor    — on-demand single-donor refresh (HTTP, ?sf_id=...)
  analyze_campaign — on-demand single-campaign refresh (HTTP, ?sf_id=...)

Scoring outputs per donor:
  - RFM scores (1-5 each: Recency, Frequency, Monetary)
  - upgrade_propensity (0-1)
  - lapse_risk (0-1)
  - ai_score (0-100 composite)
  - ask_amount (next ask in dollars)
  - ask_rationale (1-2 sentences)
  - ai_narrative (3-5 sentence donor portrait)

Scoring outputs per campaign:
  - ai_score (0-100)
  - segment_performance (JSON: which donor segments responded best)
  - recommendations (list of strings)
  - ai_narrative (3-5 sentence summary)
"""

import os
import json
import logging
import time
import math
import functions_framework
from datetime import datetime, timezone, timedelta
from google.cloud import storage
import anthropic

from shared.secrets import get_secret
from shared.sheets import FISSheets

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CLAUDE_MODEL = "claude-haiku-4-5-20251001"  # Fast + cheap for batch analysis
BATCH_SIZE   = 10                            # Donors per Claude call (10 keeps output under 8K tokens)
MAX_DONORS_PER_RUN = 800                     # 80 batches × ~40s = ~3200s, fits in 3600s function timeout


# ── Entry Points ─────────────────────────────────────────────────────────────

@functions_framework.http
def analyze_batch(request):
    """Nightly batch: analyze all donors/campaigns not analyzed in the last 7 days."""
    start = time.time()
    stats = {"donors_processed": 0, "campaigns_processed": 0, "errors": 0}

    sheet_id = get_secret("FIS_SHEET_ID")
    bucket_name = get_secret("GCS_BUCKET")
    api_key = get_secret("ANTHROPIC_API_KEY")
    sheets = FISSheets(spreadsheet_id=sheet_id)
    client = anthropic.Anthropic(api_key=api_key)
    gcs = storage.Client()
    bucket = gcs.bucket(bucket_name)

    # Load full donor list from GCS
    try:
        donors = json.loads(bucket.blob("donors/latest.json").download_as_text())
    except Exception as e:
        return {"status": "error", "message": f"Could not load donors from GCS: {e}"}, 500

    # Filter to donors needing analysis — prioritize never-analyzed, then stale (>7 days)
    stale_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
    never_analyzed = [d for d in donors if not d.get("last_analyzed")]
    stale_analyzed = [d for d in donors if d.get("last_analyzed") and d["last_analyzed"] < stale_cutoff]
    stale = (never_analyzed + stale_analyzed)[:MAX_DONORS_PER_RUN]
    logger.info(f"Analyzing {len(stale)} stale donors (of {len(donors)} total)")

    # Process in batches — sleep between calls to respect 10K token/min rate limit
    updated = {}
    for i in range(0, len(stale), BATCH_SIZE):
        batch = stale[i:i + BATCH_SIZE]
        if i > 0:
            time.sleep(20)  # 10K token/min limit: ~1500 tokens/batch → 1 batch per 9s; 20s is safe buffer
        try:
            results = _analyze_donor_batch(client, batch)
            for sf_id, analysis in results.items():
                updated[sf_id] = analysis
                stats["donors_processed"] += 1
        except Exception as e:
            logger.error(f"Batch {i//BATCH_SIZE + 1} failed: {e}")
            stats["errors"] += 1

    # Merge analysis back into donor list and write to GCS
    donor_map = {d["sf_id"]: d for d in donors}
    for sf_id, analysis in updated.items():
        if sf_id in donor_map:
            donor_map[sf_id].update(analysis)
    merged = list(donor_map.values())
    bucket.blob("donors/latest.json").upload_from_string(
        json.dumps(merged, default=str), content_type="application/json"
    )

    # Sheets writes are best-effort
    try:
        updated_donors = [donor_map[sid] for sid in updated if sid in donor_map]
        sheets.bulk_upsert_donors(updated_donors)
    except Exception as e:
        logger.warning(f"Sheets donors write skipped: {e}")

    stats["elapsed_seconds"] = round(time.time() - start, 1)
    try:
        sheets.log_run("claude_analysis", stats)
    except Exception as e:
        logger.warning(f"Sheets run log skipped: {e}")
    logger.info(f"analyze_batch complete: {stats}")
    return {"status": "ok", "stats": stats}, 200


@functions_framework.http
def analyze_donor(request):
    """On-demand: analyze a single donor by Salesforce ID."""
    sf_id = request.args.get("sf_id")
    if not sf_id:
        return {"error": "sf_id query param required"}, 400

    sheet_id = get_secret("FIS_SHEET_ID")
    bucket_name = get_secret("GCS_BUCKET")
    api_key = get_secret("ANTHROPIC_API_KEY")
    sheets = FISSheets(spreadsheet_id=sheet_id)
    client = anthropic.Anthropic(api_key=api_key)
    gcs = storage.Client()
    bucket = gcs.bucket(bucket_name)

    try:
        donors = json.loads(bucket.blob("donors/latest.json").download_as_text())
    except Exception as e:
        return {"error": f"Could not load donors: {e}"}, 500

    donor_map = {d["sf_id"]: d for d in donors}
    donor = donor_map.get(sf_id)
    if not donor:
        return {"error": f"Donor {sf_id} not found in cache"}, 404

    try:
        results = _analyze_donor_batch(client, [donor])
        analysis = results.get(sf_id, {})
        donor_map[sf_id].update(analysis)

        bucket.blob("donors/latest.json").upload_from_string(
            json.dumps(list(donor_map.values()), default=str),
            content_type="application/json"
        )
    except Exception as e:
        logger.error(f"analyze_donor failed for {sf_id}: {e}")
        return {"error": f"Analysis failed: {e}"}, 500

    try:
        sheets.upsert_donor(donor_map[sf_id])
    except Exception as e:
        logger.warning(f"Sheets donor upsert skipped: {e}")
    return {"status": "ok", "sf_id": sf_id, "analysis": analysis}, 200


# ── Claude Analysis Logic ─────────────────────────────────────────────────────

def _analyze_donor_batch(client: anthropic.Anthropic, donors: list[dict]) -> dict[str, dict]:
    """
    Send a batch of donors to Claude for scoring.
    Returns {sf_id: analysis_dict} for each donor.
    """
    now = datetime.now(timezone.utc)

    # Build compact donor summaries for the prompt
    donor_summaries = []
    for d in donors:
        # Calculate days since last gift
        days_since_gift = None
        if d.get("last_gift_date"):
            try:
                lg = datetime.fromisoformat(d["last_gift_date"].replace("Z", "+00:00"))
                if lg.tzinfo is None:
                    lg = lg.replace(tzinfo=timezone.utc)
                days_since_gift = (now - lg).days
            except Exception:
                pass

        # Summarize recent activities (calls, emails, meetings, visits)
        activities = d.get("activities", [])
        activity_summary = []
        for act in activities[:10]:  # Include up to 10 most recent
            entry = f"{act.get('date', '?')}: {act.get('type', '?')} — {act.get('subject', 'No subject')}"
            desc = act.get("description", "").strip()
            if desc:
                entry += f" ({desc[:100]})"
            activity_summary.append(entry)

        # Summarize affiliations (organizational roles)
        affiliation_summary = []
        for aff in d.get("affiliations", [])[:5]:
            entry = {"org": aff.get("org_name", ""), "role": aff.get("role", ""), "status": aff.get("status", "")}
            if aff.get("primary"):
                entry["primary"] = True
            affiliation_summary.append(entry)

        summary = {
            "sf_id": d["sf_id"],
            "name": d.get("full_name", "Unknown"),
            "entity_type": d.get("entity_type", "individual"),
            "total_giving": d.get("total_giving", 0),
            "giving_this_fy": d.get("giving_this_fy", 0),
            "giving_last_fy": d.get("giving_last_fy", 0),
            "last_gift_amount": d.get("last_gift_amount", 0),
            "last_gift_days_ago": days_since_gift,
            "gift_count": d.get("gift_count", 0),
            "is_recurring": d.get("is_recurring", False),
            "rd_amount": d.get("rd_amount", 0),
            "rd_period": d.get("rd_period", ""),
            "activity_count": d.get("activity_count", 0),
            "last_activity_date": d.get("last_activity_date", ""),
            "recent_activities": activity_summary,
            "affiliations": affiliation_summary,
        }
        donor_summaries.append(summary)

    prompt = _build_batch_prompt(donor_summaries)

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text
    return _parse_batch_response(raw, donors)


def _build_batch_prompt(summaries: list[dict]) -> str:
    donors_json = json.dumps(summaries, indent=2)
    return f"""You are a nonprofit fundraising analyst for Water4.org, which builds clean water infrastructure in developing countries.

Analyze the following {len(summaries)} donors and return a JSON object mapping each sf_id to an analysis.

Donor data (includes recent activity history from calls, emails, meetings, and visits):
{donors_json}

Water4 Giving Tiers (annual):
- Transformational: $100,000+
- Leadership: $25,000–$99,999
- Major: $10,000–$24,999
- Mid-Level: $5,000–$9,999
- Donor: $1,000–$4,999
- Friend: $1–$999

For EACH donor, return:
- rfm_recency: 1-5 (5 = gave in last 90 days, 1 = lapsed 3+ years)
- rfm_frequency: 1-5 (5 = 10+ lifetime gifts, 1 = single gift)
- rfm_monetary: 1-5 (5 = Transformational, 1 = Friend)
- upgrade_propensity: 0.0–1.0 (likelihood to upgrade tier this FY)
- lapse_risk: 0.0–1.0 (likelihood to lapse/not give this FY)
- ai_score: 0-100 composite engagement score
- ask_amount: recommended next ask in whole dollars (next tier threshold × 0.85)
- ask_rationale: 1-2 sentence rationale
- ai_narrative: 3-5 sentence donor portrait for the gift officer

Scoring guidelines:
- Recurring donors should have lower lapse_risk (max 0.3 if active RD)
- YoY decline (giving_this_fy < giving_last_fy) increases lapse_risk
- Days since last gift strongly drives rfm_recency
- upgrade_propensity should be higher for donors at 70%+ of next tier
- ask_amount should never be lower than their last gift amount
- ai_narrative should be warm, specific, and actionable for a gift officer

Activity history guidelines:
- recent_activities contains logged calls, emails, meetings, and visits from Salesforce
- High activity frequency with recent touchpoints indicates strong engagement — boost ai_score
- Long gaps between activities suggest the donor may feel neglected — increase lapse_risk
- Reference specific interactions in the ai_narrative (e.g., "Recent meeting discussed field visit plans")
- If recent activities mention asks, proposals, or commitments, factor this into ask_rationale
- Donors with zero activities despite high giving are at risk — flag in narrative
- Use activity patterns to recommend the right engagement style in ai_narrative

Entity type & affiliation guidelines:
- entity_type: "individual" (personal cultivation), "organization" (institutional ask), "affiliated_individual" (person with organizational roles — highest value)
- affiliations lists the donor's organizational roles (e.g., Board Member, Pastor, Executive Director)
- A current Board Member or Executive Director at a foundation or major institution is a HIGH-VALUE capacity signal — boost rfm_monetary and upgrade_propensity significantly
- Former roles are relevant context but weighted lower than current roles
- For affiliated_individual donors, reference their organizational role in ai_narrative and consider dual-track strategy (personal + institutional)
- For organization entity_type, frame ask_rationale around institutional giving capacity

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{{
  "sf_id_1": {{
    "rfm_recency": 4,
    "rfm_frequency": 3,
    "rfm_monetary": 2,
    "upgrade_propensity": 0.65,
    "lapse_risk": 0.15,
    "ai_score": 72,
    "ask_amount": 2500,
    "ask_rationale": "...",
    "ai_narrative": "...",
    "last_analyzed": "YYYY-MM-DD"
  }},
  ...
}}"""


def _parse_batch_response(raw: str, donors: list[dict]) -> dict[str, dict]:
    """Parse Claude's JSON response, with fallback for malformed output."""
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Strip any accidental markdown fences
    text = raw.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    try:
        parsed = json.loads(text)
        # Ensure last_analyzed is set
        for sf_id, analysis in parsed.items():
            if "last_analyzed" not in analysis:
                analysis["last_analyzed"] = now_str
        return parsed
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Claude response: {e}\nRaw: {raw[:500]}")
        # Return minimal fallback scores using rule-based logic
        return {d["sf_id"]: _fallback_scores(d, now_str) for d in donors}


def _fallback_scores(d: dict, now_str: str) -> dict:
    """Rule-based fallback when Claude parsing fails."""
    total = float(d.get("total_giving") or 0)
    this_fy = float(d.get("giving_this_fy") or 0)
    last_fy = float(d.get("giving_last_fy") or 0)
    gift_count = int(d.get("gift_count") or 0)
    is_recurring = bool(d.get("is_recurring"))
    days = d.get("last_gift_days_ago")

    # RFM
    if days is None: rfm_r = 1
    elif days <= 90: rfm_r = 5
    elif days <= 180: rfm_r = 4
    elif days <= 365: rfm_r = 3
    elif days <= 730: rfm_r = 2
    else: rfm_r = 1

    if gift_count >= 10: rfm_f = 5
    elif gift_count >= 5: rfm_f = 4
    elif gift_count >= 3: rfm_f = 3
    elif gift_count >= 2: rfm_f = 2
    else: rfm_f = 1

    if total >= 100000: rfm_m = 5
    elif total >= 25000: rfm_m = 4
    elif total >= 10000: rfm_m = 3
    elif total >= 5000: rfm_m = 2
    else: rfm_m = 1

    lapse_risk = 0.2 if is_recurring else (0.7 if rfm_r <= 2 else (0.5 if rfm_r == 3 else 0.2))
    if this_fy < last_fy * 0.8 and last_fy > 0:
        lapse_risk = min(1.0, lapse_risk + 0.2)

    # Next tier ask
    tiers = [0, 1000, 5000, 10000, 25000, 100000]
    next_tier = next((t for t in tiers if t > this_fy and t > last_fy), 100000)
    ask_amount = int(max(next_tier * 0.85, (d.get("last_gift_amount") or 0) * 1.1))

    return {
        "rfm_recency": rfm_r,
        "rfm_frequency": rfm_f,
        "rfm_monetary": rfm_m,
        "upgrade_propensity": 0.5,
        "lapse_risk": round(lapse_risk, 2),
        "ai_score": int((rfm_r + rfm_f + rfm_m) / 15 * 100),
        "ask_amount": ask_amount,
        "ask_rationale": "Based on giving history and tier proximity.",
        "ai_narrative": f"{d.get('full_name', 'This donor')} has given ${total:,.0f} lifetime across {gift_count} gifts.",
        "last_analyzed": now_str,
    }
