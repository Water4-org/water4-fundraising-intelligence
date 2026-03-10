"""
local_sync.py — Pull live Salesforce data and write to frontend sample-data directory.
Run: python3 local_sync.py

Reads SF credentials from .env file (SF_USERNAME, SF_PASSWORD, SF_SECURITY_TOKEN, SF_DOMAIN).
Writes donors/campaigns/actions JSON to frontend/public/sample-data/ so the Vite dev
server serves live data immediately without deploying any Cloud Functions.
"""

import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# ── Load .env ────────────────────────────────────────────────────────────────

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

# ── Check dependencies ────────────────────────────────────────────────────────

try:
    from simple_salesforce import Salesforce
except ImportError:
    print("simple-salesforce not found. Run: .venv/bin/pip install simple-salesforce")
    print("Or: python3 -m venv .venv && .venv/bin/pip install simple-salesforce")
    print("Then: .venv/bin/python3 local_sync.py")
    sys.exit(1)

# ── Credentials ───────────────────────────────────────────────────────────────

def get_credentials():
    creds = {
        "username":       os.environ.get("SF_USERNAME", ""),
        "password":       os.environ.get("SF_PASSWORD", ""),
        "security_token": os.environ.get("SF_SECURITY_TOKEN", ""),
        "domain":         os.environ.get("SF_DOMAIN", "login"),
    }

    if all([creds["username"], creds["password"], creds["security_token"]]):
        return creds

    # Prompt if not in env
    import getpass
    print("Salesforce credentials not found in .env — enter them now.")
    print("(To avoid this prompt, create a .env file — see .env.example)\n")
    creds["username"]       = input("SF username: ").strip()
    creds["password"]       = getpass.getpass("SF password: ")
    creds["security_token"] = getpass.getpass("SF security token: ")
    domain = input("SF domain [login]: ").strip()
    creds["domain"] = domain or "login"

    save = input("\nSave to .env for next time? [y/N]: ").strip().lower()
    if save == "y":
        env_path = Path(__file__).parent / ".env"
        with open(env_path, "w") as f:
            f.write(f'SF_USERNAME="{creds["username"]}"\n')
            f.write(f'SF_PASSWORD="{creds["password"]}"\n')
            f.write(f'SF_SECURITY_TOKEN="{creds["security_token"]}"\n')
            f.write(f'SF_DOMAIN="{creds["domain"]}"\n')
        print(f"Saved to {env_path}")
        print("Add .env to .gitignore — it contains secrets!")

    return creds


# ── Salesforce queries ────────────────────────────────────────────────────────

FISCAL_YEAR_START_MONTH = 7

def fy_start():
    now = datetime.now(timezone.utc)
    fy = now.year if now.month >= FISCAL_YEAR_START_MONTH else now.year - 1
    return datetime(fy, FISCAL_YEAR_START_MONTH, 1, tzinfo=timezone.utc)

def classify_tier(amount):
    n = float(amount or 0)
    if n >= 100000: return "transformational"
    if n >= 25000:  return "leadership"
    if n >= 10000:  return "major"
    if n >= 5000:   return "mid_level"
    if n >= 1000:   return "donor"
    if n >= 1:      return "friend"
    return "prospect"

def fetch_donors(sf):
    print("  Fetching contacts...")
    result = sf.query_all("""
        SELECT Id, AccountId, FirstName, LastName, Email, Phone, MobilePhone,
               MailingCity, MailingState, MailingCountry,
               npo02__TotalOppAmount__c, npo02__OppAmountThisYear__c,
               npo02__OppAmountLastYear__c, npo02__NumberOfClosedOpps__c,
               npo02__LastCloseDate__c, npo02__FirstCloseDate__c, npo02__LastOppAmount__c,
               OwnerId, Owner.Name
        FROM Contact
        WHERE npo02__TotalOppAmount__c > 0
        ORDER BY npo02__TotalOppAmount__c DESC NULLS LAST
        LIMIT 2000
    """)
    contacts = result["records"]
    print(f"  → {len(contacts)} contacts fetched")

    # Recurring donations
    rds_by_contact = {}
    try:
        rd_result = sf.query_all("""
            SELECT Id, npe03__Contact__c, npe03__Amount__c,
                   npe03__Installment_Period__c, npe03__Next_Payment_Date__c,
                   npe03__Open_Ended_Status__c
            FROM npe03__Recurring_Donation__c
            WHERE npe03__Open_Ended_Status__c = 'Open'
            LIMIT 2000
        """)
        for rd in rd_result["records"]:
            cid = rd.get("npe03__Contact__c")
            if cid:
                rds_by_contact[cid] = rd
        print(f"  → {len(rds_by_contact)} active recurring donations")
    except Exception as e:
        print(f"  → Recurring donations unavailable: {e}")

    donors = []
    for c in contacts:
        rd = rds_by_contact.get(c["Id"])
        total     = float(c.get("npo02__TotalOppAmount__c") or 0)
        this_fy   = float(c.get("npo02__OppAmountThisYear__c") or 0)
        last_fy   = float(c.get("npo02__OppAmountLastYear__c") or 0)
        owner     = (c.get("Owner") or {}).get("Name", "")
        is_rd     = rd is not None

        donors.append({
            "_id":              c["Id"],
            "sf_id":            c["Id"],
            "account_id":       c.get("AccountId", ""),
            "first_name":       c.get("FirstName", ""),
            "last_name":        c.get("LastName", ""),
            "full_name":        f"{c.get('FirstName','')} {c.get('LastName','')}".strip(),
            "email":            c.get("Email", ""),
            "phone":            c.get("Phone", "") or c.get("MobilePhone", ""),
            "city":             c.get("MailingCity", ""),
            "state":            c.get("MailingState", ""),
            "country":          c.get("MailingCountry", ""),
            "gift_officer":     owner,
            "total_giving":     total,
            "giving_this_fy":   this_fy,
            "giving_last_fy":   last_fy,
            "last_gift_date":   c.get("npo02__LastCloseDate__c", ""),
            "last_gift_amount": float(c.get("npo02__LastOppAmount__c") or 0),
            "first_gift_date":  c.get("npo02__FirstCloseDate__c", ""),
            "gift_count":       int(c.get("npo02__NumberOfClosedOpps__c") or 0),
            "is_recurring":     is_rd,
            "rd_amount":        float((rd or {}).get("npe03__Amount__c") or 0),
            "rd_period":        (rd or {}).get("npe03__Installment_Period__c", ""),
            "rd_next_payment":  (rd or {}).get("npe03__Next_Payment_Date__c", ""),
            "ai_score":         None,
            "ai_narrative":     "",
            "rfm_recency":      None,
            "rfm_frequency":    None,
            "rfm_monetary":     None,
            "upgrade_propensity": None,
            "lapse_risk":       None,
            "ask_amount":       None,
            "ask_rationale":    "",
            "last_analyzed":    "",
        })

    return donors


def fetch_campaigns(sf):
    print("  Fetching campaigns...")
    try:
        result = sf.query_all("""
            SELECT Id, Name, Status, Type, StartDate, EndDate,
                   NumberOfContacts, NumberOfOpportunities, NumberOfWonOpportunities,
                   AmountAllOpportunities, AmountWonOpportunities,
                   ExpectedRevenue, BudgetedCost, ActualCost,
                   Description, Owner.Name
            FROM Campaign
            WHERE StartDate >= 2020-01-01
            ORDER BY StartDate DESC
            LIMIT 200
        """)
        campaigns = []
        for c in result["records"]:
            won        = float(c.get("AmountWonOpportunities") or 0)
            cost       = float(c.get("ActualCost") or 0)
            roi        = round((won - cost) / cost, 2) if cost > 0 else None
            campaigns.append({
                "sf_campaign_id":  c["Id"],
                "name":            c.get("Name", ""),
                "status":          c.get("Status", ""),
                "type":            c.get("Type", ""),
                "start_date":      c.get("StartDate", ""),
                "end_date":        c.get("EndDate", ""),
                "owner":           (c.get("Owner") or {}).get("Name", ""),
                "contacts":        int(c.get("NumberOfContacts") or 0),
                "opps_total":      int(c.get("NumberOfOpportunities") or 0),
                "opps_won":        int(c.get("NumberOfWonOpportunities") or 0),
                "amount_all":      float(c.get("AmountAllOpportunities") or 0),
                "amount_won":      won,
                "expected_revenue":float(c.get("ExpectedRevenue") or 0),
                "budget":          float(c.get("BudgetedCost") or 0),
                "actual_cost":     cost,
                "roi":             roi,
                "description":     c.get("Description", ""),
                "ai_score":        None,
                "ai_narrative":    "",
                "recommendations": [],
                "segment_performance": {},
                "last_analyzed":   "",
            })
        print(f"  → {len(campaigns)} campaigns fetched")
        return campaigns
    except Exception as e:
        print(f"  → Campaigns unavailable: {e}")
        return []


def generate_rule_based_actions(donors):
    """
    Generate the annual stewardship action queue from donor data.

    Each tier follows a calendar-based outreach journey keyed on days since last gift:

    Transformational ($100K+)
      0-5d:   Handwritten thank-you letter
      6-45d:  30-day impact call
      46-120d: Quarterly cultivation meeting
      121-210d: Field visit invitation
      211-300d: Annual giving conversation (meeting)
      301-365d: Lapse recovery call (urgent)
      365d+:  Urgent lapse recovery call

    Leadership ($25K-$99,999)
      0-5d:   Handwritten thank-you letter
      6-75d:  60-day impact call
      76-180d: Stewardship check-in call
      181-300d: Annual giving conversation (meeting)
      301d+:  Lapse recovery call (urgent)

    Major ($10K-$24,999)
      0-5d:   Handwritten thank-you letter
      6-105d: 90-day check-in call
      106-270d: Send impact report
      271-365d: Annual giving conversation (meeting)
      365d+:  Lapse recovery call

    Mid-Level ($5K-$9,999)
      0-14d:  Thank-you call
      150-270d: Mid-year impact report
      271-365d: Annual ask call
      365d+:  Lapse recovery call

    Donor ($1K-$4,999)
      0-14d:  Thank-you email
      270-365d: Annual ask email
      365d+:  Lapse recovery email

    Friend ($1-$999)
      270d+:  Annual appeal email

    All tiers: upgrade ask if at 70%+ of next tier threshold
    All tiers: recurring gift thank-you 14 days before next payment
    """
    now = datetime.now(timezone.utc)
    import uuid

    # Stewardship calendar: tier → list of steps
    # Each step: (day_min, day_max, action_type, activity, label, priority, due_days, ask_multiplier)
    # ask_multiplier: None = no ask, float = multiplier of last_fy for the ask amount
    CALENDAR = {
        "transformational": [
            (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",      1,  3,  None),
            (6,   45,  "impact_followup", "call",             "30-Day Impact Call",                1,  3,  None),
            (46,  120, "checkin_90day",   "meeting",          "Quarterly Cultivation Meeting",     1,  7,  None),
            (121, 210, "field_visit",     "field_visit",      "Field Visit Invitation",            1,  14, None),
            (211, 300, "annual_ask",      "meeting",          "Annual Giving Conversation",        1,  14, 1.0),
            (301, 365, "lapse_outreach",  "call",             "Lapse Recovery Call",               1,  5,  1.0),
            (366, 9999,"lapse_outreach",  "call",             "Urgent Lapse Recovery Call",        1,  3,  1.0),
        ],
        "leadership": [
            (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",      1,  3,  None),
            (6,   75,  "impact_followup", "call",             "60-Day Impact Call",                1,  5,  None),
            (76,  180, "checkin_90day",   "call",             "Stewardship Check-In Call",         2,  7,  None),
            (181, 300, "annual_ask",      "meeting",          "Annual Giving Conversation",        2,  14, 1.0),
            (301, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",               1,  5,  1.0),
        ],
        "major": [
            (0,   5,   "gift_thank_you",  "handwritten_note", "Handwritten Thank-You Letter",      2,  5,  None),
            (6,   105, "checkin_90day",   "call",             "90-Day Check-In Call",              2,  7,  None),
            (106, 270, "impact_report",   "impact_report",    "Send Impact Report",                2,  14, None),
            (271, 365, "annual_ask",      "meeting",          "Annual Giving Conversation",        2,  14, 1.0),
            (366, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",               2,  7,  1.0),
        ],
        "mid_level": [
            (0,   14,  "gift_thank_you",  "call",             "Thank-You Call",                   3,  7,  None),
            (150, 270, "impact_report",   "impact_report",    "Mid-Year Impact Report",            3,  14, None),
            (271, 365, "annual_ask",      "call",             "Annual Ask Call",                   3,  14, 1.0),
            (366, 9999,"lapse_outreach",  "call",             "Lapse Recovery Call",               3,  14, 1.0),
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

    def make_action(atype, activity, label, priority, due_days, donor, tier, ask=None, reason=""):
        return {
            "action_id":      f"A{uuid.uuid4().hex[:8].upper()}",
            "created_at":     now.strftime("%Y-%m-%d %H:%M:%S UTC"),
            "due_date":       (now + timedelta(days=due_days)).strftime("%Y-%m-%d"),
            "priority":       priority,
            "action_type":    atype,
            "activity":       activity,
            "label":          label,
            "gift_officer":   donor.get("gift_officer", "Unassigned"),
            "donor_name":     donor.get("full_name", ""),
            "donor_sf_id":    donor.get("sf_id", ""),
            "donor_tier":     tier,
            "donor_ai_score": donor.get("ai_score"),
            "ask_amount":     ask,
            "reason":         reason,
            "ai_narrative":   donor.get("ai_narrative", ""),
            "status":         "pending",
            "completed_at":   "",
            "notes":          "",
        }

    actions = []

    for d in donors:
        total   = float(d.get("total_giving") or 0)
        this_fy = float(d.get("giving_this_fy") or 0)
        last_fy = float(d.get("giving_last_fy") or 0)
        best_yr = max(this_fy, last_fy)
        tier    = classify_tier(best_yr or total / max(d.get("gift_count", 1), 1))

        # Days since last gift
        days = None
        if d.get("last_gift_date"):
            try:
                lg = datetime.fromisoformat(str(d["last_gift_date"]).replace("Z", "+00:00"))
                if lg.tzinfo is None:
                    lg = lg.replace(tzinfo=timezone.utc)
                days = (now - lg).days
            except Exception:
                pass

        # ── Stewardship calendar step ────────────────────────────────────────
        if days is not None:
            for (dmin, dmax, atype, activity, label, pri, due, ask_mult) in CALENDAR.get(tier, []):
                if dmin <= days <= dmax:
                    ask = int(max(last_fy, best_yr) * ask_mult) if ask_mult else None
                    actions.append(make_action(
                        atype, activity, label, pri, due, d, tier, ask=ask,
                        reason=f"{days} days since last gift — {label.lower()}",
                    ))
                    break  # one calendar step per donor per sync

        # ── Upgrade ask (independent of calendar) ────────────────────────────
        tier_thresholds = [1000, 5000, 10000, 25000, 100000, 250000]
        for threshold in tier_thresholds:
            if best_yr > 0 and best_yr >= threshold * 0.7 and best_yr < threshold:
                gap = threshold - best_yr
                ask = int(threshold * 0.9)
                actions.append(make_action(
                    "upgrade_ask", "meeting", "Upgrade Cultivation Ask",
                    {"transformational": 1, "leadership": 1, "major": 2,
                     "mid_level": 2, "donor": 3, "friend": 4}.get(tier, 3),
                    21, d, tier, ask=ask,
                    reason=f"${gap:,.0f} from {tier.replace('_','-')} → next tier — suggest ${ask:,} ask",
                ))
                break

        # ── Recurring gift thank-you (14 days before next payment) ───────────
        if d.get("is_recurring") and d.get("rd_next_payment"):
            try:
                np = datetime.fromisoformat(str(d["rd_next_payment"]).replace("Z", "+00:00"))
                if np.tzinfo is None:
                    np = np.replace(tzinfo=timezone.utc)
                days_to = (np - now).days
                if 0 <= days_to <= 14:
                    actions.append(make_action(
                        "recurring_ack", "handwritten_note", "Recurring Gift Thank-You",
                        3, days_to, d, tier,
                        reason=f"Recurring gift of ${d.get('rd_amount', 0):,.0f} due in {days_to} days",
                    ))
            except Exception:
                pass

    actions.sort(key=lambda a: (a["priority"], a["donor_name"]))
    return actions


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print("=== Water4 FIS — Local Sync ===\n")

    creds = get_credentials()

    print(f"\nConnecting to Salesforce ({creds['domain']}.salesforce.com)...")
    try:
        sf = Salesforce(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            domain=creds["domain"],
        )
        print(f"✅ Connected: {sf.sf_instance}\n")
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        sys.exit(1)

    start = time.time()

    print("Fetching data...")
    donors    = fetch_donors(sf)
    campaigns = fetch_campaigns(sf)
    actions   = generate_rule_based_actions(donors)

    print(f"\nGenerating {len(actions)} actions from {len(donors)} donors...")

    # Write to frontend/public/sample-data/
    out_dir = Path(__file__).parent / "frontend" / "public" / "sample-data"
    (out_dir / "donors").mkdir(parents=True, exist_ok=True)
    (out_dir / "campaigns").mkdir(parents=True, exist_ok=True)
    (out_dir / "actions").mkdir(parents=True, exist_ok=True)

    (out_dir / "donors"    / "latest.json").write_text(json.dumps(donors,    indent=2, default=str))
    (out_dir / "campaigns" / "latest.json").write_text(json.dumps(campaigns, indent=2, default=str))
    (out_dir / "actions"   / "latest.json").write_text(json.dumps(actions,   indent=2, default=str))

    elapsed = round(time.time() - start, 1)
    print(f"\n✅ Sync complete in {elapsed}s")
    print(f"   {len(donors)} donors | {len(campaigns)} campaigns | {len(actions)} actions")
    print(f"\nData written to frontend/public/sample-data/")
    print("Vite dev server will serve the updated data automatically.")
    print("Refresh http://localhost:5173/water4-fis/ to see live Salesforce data.")

    # Offer to store in Secret Manager for Cloud Function use
    try:
        store = input("\nAlso store SF credentials in GCP Secret Manager for Cloud Function deployment? [y/N]: ").strip().lower()
    except EOFError:
        store = "n"

    if store == "y":
        try:
            from google.cloud import secretmanager
            sm = secretmanager.SecretManagerServiceClient()
            parent = "projects/water4-org"
            secret_id = "SF_CREDENTIALS"
            payload = json.dumps(creds).encode()
            try:
                sm.create_secret(request={"parent": parent, "secret_id": secret_id,
                                          "secret": {"replication": {"automatic": {}}}})
            except Exception:
                pass
            sm.add_secret_version(request={
                "parent": f"{parent}/secrets/{secret_id}",
                "payload": {"data": payload},
            })
            print("✅ SF_CREDENTIALS stored in Secret Manager")
        except Exception as e:
            print(f"Warning: Could not store in Secret Manager: {e}")
            print("Run: .venv/bin/pip install google-cloud-secret-manager")


if __name__ == "__main__":
    main()
