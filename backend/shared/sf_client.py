"""
sf_client.py — Salesforce client for the Fundraising Intelligence System.

Uses simple-salesforce with Username-Password (Connected App) OAuth flow.
Credentials stored in Secret Manager as SF_CREDENTIALS JSON:
  { "username": "...", "password": "...", "security_token": "...", "domain": "login" }

Fetches NPSP household-deduplicated data:
  - npe03__Recurring_Donation__c  (Recurring Donations)
  - npsp__General_Accounting_Unit__c / OpportunityContactRole / Opportunity (one-time gifts)
  - Contact (primary contact per account)

Returns normalized donor dicts compatible with the React dashboard CSV format.
"""

import logging
from datetime import datetime, timezone, timedelta
from simple_salesforce import Salesforce
from .secrets import get_secret_json

logger = logging.getLogger(__name__)

FISCAL_YEAR_START_MONTH = 7   # Water4 FY starts July 1


def _fiscal_year_start(year=None) -> datetime:
    """Return datetime for the start of the current (or given) fiscal year."""
    now = datetime.now(timezone.utc)
    fy = year or (now.year if now.month >= FISCAL_YEAR_START_MONTH else now.year - 1)
    return datetime(fy, FISCAL_YEAR_START_MONTH, 1, tzinfo=timezone.utc)


def get_sf_client() -> Salesforce:
    """Create an authenticated Salesforce client using stored credentials."""
    creds = get_secret_json("SF_CREDENTIALS")
    sf = Salesforce(
        username=creds["username"],
        password=creds["password"],
        security_token=creds["security_token"],
        domain=creds.get("domain", "login"),
    )
    logger.info(f"Salesforce connected: {sf.sf_instance}")
    return sf


# ── Data Queries ──────────────────────────────────────────────────────────────

CONTACT_FIELDS = """
    Id, AccountId, FirstName, LastName, Email, Phone, MobilePhone,
    MailingCity, MailingState, MailingCountry,
    Account.Stage__c,
    Account.Stage_Entry_Date__c,
    Current_Action_Plan__c,
    Current_Action_Plan_Date__c,
    Previous_Action_Plan__c,
    npsp__Primary_Affiliation__c,
    npo02__TotalOppAmount__c,
    npo02__OppAmountThisYear__c,
    npo02__OppAmountLastYear__c,
    npo02__OppAmountLastNDays__c,
    npo02__NumberOfClosedOpps__c,
    npo02__LastCloseDate__c,
    npo02__FirstCloseDate__c,
    npo02__LastOppAmount__c,
    Description,
    OwnerId, Owner.Name
"""

RD_FIELDS = """
    Id, Name, npe03__Contact__c, npe03__Amount__c, npe03__Installment_Period__c,
    npe03__Date_Established__c, npe03__Next_Payment_Date__c,
    npe03__Open_Ended_Status__c, npe03__Last_Payment_Date__c,
    npe03__Last_Payment_Amount__c, npe03__Installments_Paid_Quantity__c,
    npe03__Organization__c
"""

OPP_FIELDS = """
    Id, AccountId, Amount, CloseDate, StageName, Name, Description,
    CampaignId, Campaign.Name, npe01__Contact_Id_for_Role__c
"""

TASK_FIELDS = """
    Id, WhoId, Subject, Status, ActivityDate, Description,
    Type, TaskSubtype, OwnerId, Owner.Name, CreatedDate,
    Held_Meaningful_Conversation__c
"""

EVENT_FIELDS = """
    Id, WhoId, Subject, StartDateTime, EndDateTime, Description,
    Type, OwnerId, Owner.Name, CreatedDate
"""

AFFILIATION_FIELDS = """
    Id, npe5__Contact__c, npe5__Organization__c, npe5__Organization__r.Name,
    npe5__Role__c, npe5__Status__c, npe5__StartDate__c, npe5__EndDate__c,
    npe5__Primary__c
"""


def fetch_all_donors(sf: Salesforce, days_back: int = 730) -> list[dict]:
    """
    Pull all contacts with giving history from Salesforce.
    Returns list of normalized donor dicts.
    """
    logger.info("Fetching contacts from Salesforce...")

    # Primary contacts with giving history
    contacts_soql = f"""
        SELECT {CONTACT_FIELDS}
        FROM Contact
        WHERE npo02__TotalOppAmount__c > 0
        ORDER BY npo02__TotalOppAmount__c DESC NULLS LAST
        LIMIT 5000
    """
    contacts_result = sf.query_all(contacts_soql)
    contacts = {c["Id"]: c for c in contacts_result["records"]}
    logger.info(f"Fetched {len(contacts)} contacts")

    # Recent opportunities for FY calculation + timeline
    since = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")
    opps_soql = f"""
        SELECT {OPP_FIELDS}
        FROM Opportunity
        WHERE StageName = 'Closed Won'
          AND CloseDate >= {since}
        ORDER BY CloseDate DESC
        LIMIT 10000
    """
    opps_result = sf.query_all(opps_soql)
    opps_by_contact: dict[str, list] = {}
    for opp in opps_result["records"]:
        cid = opp.get("npe01__Contact_Id_for_Role__c") or opp.get("AccountId", "")
        if cid:
            opps_by_contact.setdefault(cid, []).append(opp)
    logger.info(f"Fetched {len(opps_result['records'])} recent opportunities")

    # Recurring donations
    rds_soql = f"""
        SELECT {RD_FIELDS}
        FROM npe03__Recurring_Donation__c
        WHERE npe03__Open_Ended_Status__c = 'Open'
        LIMIT 5000
    """
    try:
        rds_result = sf.query_all(rds_soql)
        rds_by_contact: dict[str, dict] = {}
        for rd in rds_result["records"]:
            cid = rd.get("npe03__Contact__c")
            if cid:
                rds_by_contact[cid] = rd
        logger.info(f"Fetched {len(rds_result['records'])} active recurring donations")
    except Exception as e:
        logger.warning(f"Could not fetch recurring donations: {e}")
        rds_by_contact = {}

    # Fetch activity history (Tasks + Events) for all contacts
    activities_by_contact = _fetch_activities(sf, list(contacts.keys()), days_back)

    # Fetch affiliations (organizational roles)
    affiliations_by_contact = _fetch_affiliations(sf, list(contacts.keys()))

    # Normalize into donor dicts
    donors = []
    fy_start = _fiscal_year_start()
    for cid, c in contacts.items():
        donor = _normalize_contact(
            c, opps_by_contact.get(cid, []), rds_by_contact.get(cid), fy_start,
            activities_by_contact.get(cid, []),
            affiliations_by_contact.get(cid, [])
        )
        donors.append(donor)

    logger.info(f"Normalized {len(donors)} donors")
    return donors


def _fetch_affiliations(sf: Salesforce, contact_ids: list[str]) -> dict[str, list]:
    """Fetch npe5__Affiliation__c records for contacts, grouped by Contact ID."""
    if not contact_ids:
        return {}

    affiliations_by_contact: dict[str, list] = {}

    for i in range(0, len(contact_ids), 200):
        chunk = contact_ids[i:i + 200]
        ids_str = "','".join(chunk)
        try:
            soql = f"""
                SELECT {AFFILIATION_FIELDS}
                FROM npe5__Affiliation__c
                WHERE npe5__Contact__c IN ('{ids_str}')
                ORDER BY npe5__Primary__c DESC, npe5__StartDate__c DESC
            """
            result = sf.query_all(soql)
            for a in result["records"]:
                cid = a.get("npe5__Contact__c")
                if cid:
                    org_ref = a.get("npe5__Organization__r") or {}
                    affiliations_by_contact.setdefault(cid, []).append({
                        "org_sf_id": a.get("npe5__Organization__c", ""),
                        "org_name": org_ref.get("Name", ""),
                        "role": a.get("npe5__Role__c", ""),
                        "status": a.get("npe5__Status__c", ""),
                        "start_date": a.get("npe5__StartDate__c", ""),
                        "end_date": a.get("npe5__EndDate__c", ""),
                        "primary": bool(a.get("npe5__Primary__c")),
                    })
            logger.info(f"Fetched {len(result['records'])} affiliations (chunk {i//200 + 1})")
        except Exception as e:
            logger.warning(f"Could not fetch affiliations (chunk {i//200 + 1}): {e}")

    total = sum(len(v) for v in affiliations_by_contact.values())
    logger.info(f"Total affiliations fetched: {total} across {len(affiliations_by_contact)} contacts")
    return affiliations_by_contact


def _fetch_activities(sf: Salesforce, contact_ids: list[str], days_back: int = 730) -> dict[str, list]:
    """Fetch Task and Event records for a list of contacts, grouped by WhoId."""
    if not contact_ids:
        return {}

    since = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime("%Y-%m-%d")
    activities_by_contact: dict[str, list] = {}

    # Fetch Tasks (calls, emails, logged activities)
    # Process in chunks of 200 to avoid SOQL IN clause limits
    for i in range(0, len(contact_ids), 200):
        chunk = contact_ids[i:i + 200]
        ids_str = "','".join(chunk)
        try:
            tasks_soql = f"""
                SELECT {TASK_FIELDS}
                FROM Task
                WHERE WhoId IN ('{ids_str}')
                  AND ActivityDate >= {since}
                ORDER BY ActivityDate DESC
                LIMIT 10000
            """
            result = sf.query_all(tasks_soql)
            for t in result["records"]:
                cid = t.get("WhoId")
                if cid:
                    activities_by_contact.setdefault(cid, []).append({
                        "type": "task",
                        "subject": t.get("Subject", ""),
                        "date": t.get("ActivityDate", ""),
                        "status": t.get("Status", ""),
                        "task_type": t.get("Type", ""),
                        "subtype": t.get("TaskSubtype", ""),
                        "owner": (t.get("Owner") or {}).get("Name", ""),
                        "description": (t.get("Description") or "")[:200],
                        "held_meaningful_conversation": t.get("Held_Meaningful_Conversation__c", ""),
                    })
            logger.info(f"Fetched {len(result['records'])} tasks (chunk {i//200 + 1})")
        except Exception as e:
            logger.warning(f"Could not fetch tasks (chunk {i//200 + 1}): {e}")

    # Fetch Events (meetings, visits)
    for i in range(0, len(contact_ids), 200):
        chunk = contact_ids[i:i + 200]
        ids_str = "','".join(chunk)
        try:
            events_soql = f"""
                SELECT {EVENT_FIELDS}
                FROM Event
                WHERE WhoId IN ('{ids_str}')
                  AND StartDateTime >= {since}T00:00:00Z
                ORDER BY StartDateTime DESC
                LIMIT 10000
            """
            result = sf.query_all(events_soql)
            for e in result["records"]:
                cid = e.get("WhoId")
                if cid:
                    activities_by_contact.setdefault(cid, []).append({
                        "type": "event",
                        "subject": e.get("Subject", ""),
                        "date": (e.get("StartDateTime") or "")[:10],
                        "event_type": e.get("Type", ""),
                        "owner": (e.get("Owner") or {}).get("Name", ""),
                        "description": (e.get("Description") or "")[:200],
                    })
            logger.info(f"Fetched {len(result['records'])} events (chunk {i//200 + 1})")
        except Exception as e:
            logger.warning(f"Could not fetch events (chunk {i//200 + 1}): {e}")

    # Sort each contact's activities by date descending, keep most recent 20
    for cid in activities_by_contact:
        activities_by_contact[cid] = sorted(
            activities_by_contact[cid],
            key=lambda a: a.get("date", ""),
            reverse=True
        )[:20]

    total = sum(len(v) for v in activities_by_contact.values())
    logger.info(f"Total activities fetched: {total} across {len(activities_by_contact)} contacts")
    return activities_by_contact


def _normalize_contact(c: dict, opps: list, rd: dict | None, fy_start: datetime, activities: list | None = None, affiliations: list | None = None) -> dict:
    """Convert a Salesforce Contact + related records into a flat donor dict."""
    total_giving = float(c.get("npo02__TotalOppAmount__c") or 0)
    giving_this_fy = float(c.get("npo02__OppAmountThisYear__c") or 0)
    giving_last_fy = float(c.get("npo02__OppAmountLastYear__c") or 0)
    last_gift_date = c.get("npo02__LastCloseDate__c", "")
    last_gift_amount = float(c.get("npo02__LastOppAmount__c") or 0)
    first_gift_date = c.get("npo02__FirstCloseDate__c", "")
    gift_count = int(c.get("npo02__NumberOfClosedOpps__c") or 0)
    owner_name = (c.get("Owner") or {}).get("Name", "")

    # Recurring donation info
    is_recurring = rd is not None
    rd_amount = float((rd or {}).get("npe03__Amount__c") or 0)
    rd_period = (rd or {}).get("npe03__Installment_Period__c", "")
    rd_next_payment = (rd or {}).get("npe03__Next_Payment_Date__c", "")
    rd_established = (rd or {}).get("npe03__Date_Established__c", "")

    # Recent opps for timeline
    recent_gifts = []
    for opp in sorted(opps, key=lambda o: o.get("CloseDate", ""), reverse=True)[:10]:
        recent_gifts.append({
            "date": opp.get("CloseDate", ""),
            "amount": float(opp.get("Amount") or 0),
            "campaign": (opp.get("Campaign") or {}).get("Name", ""),
            "name": opp.get("Name", ""),
        })

    # Determine entity_type based on SF ID prefix and affiliations
    current_affiliations = [a for a in (affiliations or []) if a.get("status", "").lower() in ("current", "")]
    sf_id = c["Id"]
    account_id = c.get("AccountId", "")
    if sf_id.startswith("001"):
        entity_type = "organization"
    elif current_affiliations:
        entity_type = "affiliated_individual"
    else:
        entity_type = "individual"

    # Build primary affiliation summary for display
    primary_affiliation = None
    if current_affiliations:
        primary = next((a for a in current_affiliations if a.get("primary")), current_affiliations[0])
        if primary.get("role") and primary.get("org_name"):
            primary_affiliation = f"{primary['role']} · {primary['org_name']}"

    return {
        "_id": sf_id,
        "sf_id": sf_id,
        "account_id": account_id,
        "first_name": c.get("FirstName", ""),
        "last_name": c.get("LastName", ""),
        "full_name": f"{c.get('FirstName', '')} {c.get('LastName', '')}".strip(),
        "email": c.get("Email", ""),
        "phone": c.get("Phone", "") or c.get("MobilePhone", ""),
        "city": c.get("MailingCity", ""),
        "state": c.get("MailingState", ""),
        "country": c.get("MailingCountry", ""),
        "stage": (c.get("Account") or {}).get("Stage__c", ""),
        "stage_entry_date": (c.get("Account") or {}).get("Stage_Entry_Date__c", ""),
        "current_action_plan": c.get("Current_Action_Plan__c", ""),
        "current_action_plan_date": c.get("Current_Action_Plan_Date__c", ""),
        "previous_action_plan": c.get("Previous_Action_Plan__c", ""),
        "gift_officer": owner_name,
        "gift_officer_id": c.get("OwnerId", ""),
        "total_giving": total_giving,
        "giving_this_fy": giving_this_fy,
        "giving_last_fy": giving_last_fy,
        "last_gift_date": last_gift_date,
        "last_gift_amount": last_gift_amount,
        "first_gift_date": first_gift_date,
        "gift_count": gift_count,
        "is_recurring": is_recurring,
        "rd_amount": rd_amount,
        "rd_period": rd_period,
        "rd_next_payment": rd_next_payment,
        "rd_established": rd_established,
        "recent_gifts": recent_gifts,
        "activities": activities or [],
        "activity_count": len(activities or []),
        "last_activity_date": (activities[0]["date"] if activities else ""),
        "affiliations": affiliations or [],
        "entity_type": entity_type,
        "primary_affiliation": primary_affiliation,
        # Populated by Claude analysis layer:
        "ai_score": None,
        "ai_narrative": "",
        "rfm_recency": None,
        "rfm_frequency": None,
        "rfm_monetary": None,
        "upgrade_propensity": None,
        "lapse_risk": None,
        "ask_amount": None,
        "ask_rationale": "",
        "last_analyzed": "",
    }


def fetch_campaigns(sf: Salesforce, active_only: bool = True) -> list[dict]:
    """Fetch campaigns from Salesforce for the Appeal Index."""
    status_filter = "AND IsActive = true" if active_only else ""
    soql = f"""
        SELECT Id, Name, Status, Type, StartDate, EndDate,
               NumberOfLeads, NumberOfContacts, NumberOfConvertedLeads,
               NumberOfOpportunities, NumberOfWonOpportunities,
               AmountAllOpportunities, AmountWonOpportunities,
               ExpectedRevenue, BudgetedCost, ActualCost,
               Description, OwnerId, Owner.Name
        FROM Campaign
        WHERE StartDate >= 2020-01-01
          {status_filter}
        ORDER BY StartDate DESC
        LIMIT 500
    """
    result = sf.query_all(soql)
    logger.info(f"Fetched {len(result['records'])} campaigns")
    return [_normalize_campaign(c) for c in result["records"]]


def _normalize_campaign(c: dict) -> dict:
    """Flatten a Salesforce Campaign record."""
    won = float(c.get("AmountWonOpportunities") or 0)
    budget = float(c.get("BudgetedCost") or 0)
    actual_cost = float(c.get("ActualCost") or 0)
    roi = round((won - actual_cost) / actual_cost, 2) if actual_cost > 0 else None
    return {
        "sf_campaign_id": c["Id"],
        "name": c.get("Name", ""),
        "status": c.get("Status", ""),
        "type": c.get("Type", ""),
        "start_date": c.get("StartDate", ""),
        "end_date": c.get("EndDate", ""),
        "owner": (c.get("Owner") or {}).get("Name", ""),
        "contacts": int(c.get("NumberOfContacts") or 0),
        "opps_total": int(c.get("NumberOfOpportunities") or 0),
        "opps_won": int(c.get("NumberOfWonOpportunities") or 0),
        "amount_all": float(c.get("AmountAllOpportunities") or 0),
        "amount_won": won,
        "expected_revenue": float(c.get("ExpectedRevenue") or 0),
        "budget": budget,
        "actual_cost": actual_cost,
        "roi": roi,
        "description": c.get("Description", ""),
        # Populated by Claude analysis:
        "ai_score": None,
        "ai_narrative": "",
        "segment_performance": {},
        "recommendations": [],
        "last_analyzed": "",
    }
