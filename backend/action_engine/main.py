"""
action_engine/main.py — Cloud Function: generate prioritized gift officer actions.

Trigger: Cloud Scheduler (nightly after claude_analysis), or HTTP for on-demand
Entry point: generate_actions

Reads analyzed donor data from GCS and generates an action queue per gift officer:
  - Lapse-risk outreach (highest priority)
  - Upgrade cultivation asks
  - Recurring donation acknowledgements
  - Major donor stewardship touches
  - Campaign follow-up for non-respondents

Each action written to the FIS Control Sheet "Actions" tab and GCS.
"""

import os
import json
import logging
import time
import uuid
import functions_framework
from datetime import datetime, timezone, timedelta
from google.cloud import storage

from shared.secrets import get_secret
from shared.sheets import FISSheets

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Tier definitions (annual giving thresholds)
TIER_ORDER = ["transformational", "leadership", "major", "mid_level", "donor", "friend"]
TIER_MIN   = {
    "transformational": 100000,
    "leadership":        25000,
    "major":             10000,
    "mid_level":          5000,
    "donor":              1000,
    "friend":                1,
}


def _classify_tier(amount: float) -> str:
    for tier in TIER_ORDER:
        if amount >= TIER_MIN[tier]:
            return tier
    return "friend"


# Annual stewardship calendar: tier → list of steps
# Each step: (day_min, day_max, action_type, activity, label, priority, due_days, ask_multiplier)
# ask_multiplier: None = informational, float = multiplier of best annual year for ask amount
CALENDAR = {
    "transformational": [
        (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",   1,  3,  None),
        (6,   45,  "impact_followup", "call",             "30-Day Impact Call",              1,  3,  None),
        (46,  120, "checkin_90day",   "meeting",          "Quarterly Cultivation Meeting",   1,  7,  None),
        (121, 210, "field_visit",     "field_visit",      "Field Visit Invitation",          1,  14, None),
        (211, 300, "annual_ask",      "meeting",          "Annual Giving Conversation",      1,  14, 1.0),
        (301, 365, "lapse_outreach",  "call",             "Lapse Recovery Call",             1,  5,  1.0),
        (366, 9999,"lapse_outreach",  "call",             "Urgent Lapse Recovery Call",      1,  3,  1.0),
    ],
    "leadership": [
        (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",   1,  3,  None),
        (6,   75,  "impact_followup", "call",             "60-Day Impact Call",              1,  5,  None),
        (76,  180, "checkin_90day",   "call",             "Stewardship Check-In Call",       2,  7,  None),
        (181, 300, "annual_ask",      "meeting",          "Annual Giving Conversation",      2,  14, 1.0),
        (301, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",             1,  5,  1.0),
    ],
    "major": [
        (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",   2,  5,  None),
        (6,   105, "checkin_90day",   "call",             "90-Day Check-In Call",            2,  7,  None),
        (106, 270, "impact_report",   "impact_report",    "Send Impact Report",              2,  14, None),
        (271, 365, "annual_ask",      "meeting",          "Annual Giving Conversation",      2,  14, 1.0),
        (366, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",             2,  7,  1.0),
    ],
    "mid_level": [
        (0,   14,  "gift_thank_you",  "call",             "Thank-You Call",                  3,  7,  None),
        (150, 270, "impact_report",   "impact_report",    "Mid-Year Impact Report",           3,  14, None),
        (271, 365, "annual_ask",      "call",             "Annual Ask Call",                  3,  14, 1.0),
        (366, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",              3,  14, 1.0),
    ],
    "donor": [
        (0,   14,  "gift_thank_you",  "email",            "Thank-You Email",                  3,  5,  None),
        (270, 365, "annual_ask",      "email",            "Annual Ask Email",                  4,  21, 1.0),
        (366, 9999,"lapse_outreach",  "email",            "Lapse Recovery Email",              4,  21, 1.0),
    ],
    "friend": [
        (270, 9999,"annual_ask",      "email",            "Annual Appeal Email",               4,  30, None),
    ],
}


@functions_framework.http
def generate_actions(request):
    """Generate the action queue for all gift officers."""
    start = time.time()
    stats = {"actions_generated": 0, "errors": 0}

    sheet_id = get_secret("FIS_SHEET_ID")
    bucket_name = get_secret("GCS_BUCKET")
    sheets = FISSheets(spreadsheet_id=sheet_id)
    gcs = storage.Client()
    bucket = gcs.bucket(bucket_name)

    try:
        donors = json.loads(bucket.blob("donors/latest.json").download_as_text())
    except Exception as e:
        return {"status": "error", "message": f"Could not load donors: {e}"}, 500

    actions = []
    now = datetime.now(timezone.utc)

    for d in donors:
        donor_actions = _generate_donor_actions(d, now)
        actions.extend(donor_actions)

    # Sort by priority then by ai_score descending (most engaged high-priority donors first)
    actions.sort(key=lambda a: (a["priority"], -float(a.get("donor_ai_score") or 0)))

    # Write to GCS
    bucket.blob("actions/latest.json").upload_from_string(
        json.dumps(actions, default=str), content_type="application/json"
    )

    # Write to Sheets
    sheets.bulk_upsert_actions(actions)
    stats["actions_generated"] = len(actions)

    stats["elapsed_seconds"] = round(time.time() - start, 1)
    sheets.log_run("action_engine", stats)
    logger.info(f"generate_actions complete: {stats}")
    return {"status": "ok", "stats": stats, "action_count": len(actions)}, 200


def _generate_donor_actions(d: dict, now: datetime) -> list[dict]:
    """Generate all applicable actions for one donor using the annual stewardship calendar."""
    actions = []

    this_fy    = float(d.get("giving_this_fy") or 0)
    last_fy    = float(d.get("giving_last_fy") or 0)
    best_yr    = max(this_fy, last_fy)
    gift_count = max(int(d.get("gift_count") or 0), 1)
    total      = float(d.get("total_giving") or 0)
    tier       = _classify_tier(best_yr or total / gift_count)

    # Days since last gift
    days = None
    last_gift_date = d.get("last_gift_date", "")
    if last_gift_date:
        try:
            lg = datetime.fromisoformat(last_gift_date.replace("Z", "+00:00"))
            if lg.tzinfo is None:
                lg = lg.replace(tzinfo=timezone.utc)
            days = (now - lg).days
        except Exception:
            pass

    # ── Stewardship calendar step ────────────────────────────────────────────
    if days is not None:
        for (dmin, dmax, atype, activity, label, pri, due, ask_mult) in CALENDAR.get(tier, []):
            if dmin <= days <= dmax:
                ask = int(best_yr * ask_mult) if ask_mult else None
                actions.append(_make_action(
                    action_type=atype,
                    donor=d,
                    priority=pri,
                    reason=f"{days} days since last gift — {label.lower()}",
                    due_days=due,
                    activity_override=activity,
                    label_override=label,
                    ask_override=ask,
                ))
                break  # one calendar step per donor per sync

    # ── Upgrade ask (independent of calendar) ───────────────────────────────
    TIER_THRESHOLDS = [1000, 5000, 10000, 25000, 100000, 250000]
    for threshold in TIER_THRESHOLDS:
        if best_yr > 0 and best_yr >= threshold * 0.7 and best_yr < threshold:
            gap = threshold - best_yr
            ask = int(threshold * 0.9)
            upgrade_pri = {"transformational": 1, "leadership": 1, "major": 2,
                           "mid_level": 2, "donor": 3, "friend": 4}.get(tier, 3)
            actions.append(_make_action(
                action_type="upgrade_ask",
                donor=d,
                priority=upgrade_pri,
                reason=f"${gap:,.0f} from {tier.replace('_', '-')} → next tier — suggest ${ask:,} ask",
                due_days=21,
                activity_override="meeting",
                label_override="Upgrade Cultivation Ask",
                ask_override=ask,
            ))
            break

    # ── Recurring gift thank-you (14 days before next payment) ──────────────
    if d.get("is_recurring") and d.get("rd_next_payment"):
        try:
            next_pay = datetime.fromisoformat(str(d["rd_next_payment"]).replace("Z", "+00:00"))
            if next_pay.tzinfo is None:
                next_pay = next_pay.replace(tzinfo=timezone.utc)
            days_to = (next_pay - now).days
            if 0 <= days_to <= 14:
                actions.append(_make_action(
                    action_type="recurring_ack",
                    donor=d,
                    priority=3,
                    reason=f"Recurring gift of ${d.get('rd_amount', 0):,.0f} due in {days_to} days",
                    due_days=days_to,
                    activity_override="handwritten_note",
                    label_override="Recurring Gift Thank-You",
                ))
        except Exception:
            pass

    return actions


def _make_action(
    action_type: str,
    donor: dict,
    priority: int,
    reason: str,
    due_days: int,
    activity_override: str = None,
    label_override: str = None,
    ask_override=None,
) -> dict:
    """Create a standardized action dict."""
    now = datetime.now(timezone.utc)
    due_date = (now + timedelta(days=due_days)).strftime("%Y-%m-%d")

    return {
        "action_id":      f"A{uuid.uuid4().hex[:8].upper()}",
        "created_at":     now.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "due_date":       due_date,
        "priority":       priority,
        "action_type":    action_type,
        "activity":       activity_override or "call",
        "label":          label_override or action_type.replace("_", " ").title(),
        "gift_officer":   donor.get("gift_officer", "Unassigned"),
        "donor_name":     donor.get("full_name", "Unknown"),
        "donor_sf_id":    donor.get("sf_id", ""),
        "donor_tier":     _classify_tier(max(
            float(donor.get("giving_this_fy") or 0),
            float(donor.get("giving_last_fy") or 0),
        )),
        "donor_ai_score": donor.get("ai_score"),
        "ask_amount":     ask_override,
        "reason":         reason,
        "ai_narrative":   donor.get("ai_narrative", ""),
        "status":         "pending",
        "completed_at":   "",
        "notes":          "",
    }
