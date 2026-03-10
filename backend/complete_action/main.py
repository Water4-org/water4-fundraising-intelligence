"""
complete_action/main.py — Cloud Function: mark a gift officer action as completed.

Trigger: HTTP POST from browser (--allow-unauthenticated)
Entry point: complete_action

Accepts: POST { "action_id": "A...", "notes": "..." }
- Updates action status in GCS (actions/latest.json)
- Creates a Salesforce Task against the donor (non-fatal if SF fails)
Returns: { "status": "ok", "action_id": "...", "completed_at": "..." }
"""

import json
import logging
import functions_framework
from datetime import datetime, timezone
from google.cloud import storage

from shared.secrets import get_secret
from shared.sf_client import get_sf_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
}


def _resp(body, status=200):
    headers = {**CORS_HEADERS, "Content-Type": "application/json"}
    return json.dumps(body), status, headers


@functions_framework.http
def complete_action(request):
    if request.method == "OPTIONS":
        return "", 204, CORS_HEADERS

    if request.method != "POST":
        return _resp({"status": "error", "message": "POST required"}, 405)

    try:
        payload = request.get_json(silent=True) or {}
    except Exception:
        payload = {}

    action_id = payload.get("action_id", "").strip()
    notes = payload.get("notes", "").strip()

    if not action_id:
        return _resp({"status": "error", "message": "action_id required"}, 400)

    bucket_name = get_secret("GCS_BUCKET")
    gcs = storage.Client()
    bucket = gcs.bucket(bucket_name)
    blob = bucket.blob("actions/latest.json")

    try:
        actions = json.loads(blob.download_as_text())
    except Exception as e:
        logger.error(f"Could not load actions/latest.json: {e}")
        return _resp({"status": "error", "message": "Could not load actions"}, 500)

    action = next((a for a in actions if a.get("action_id") == action_id), None)
    if action is None:
        return _resp({"status": "error", "message": f"Action {action_id} not found"}, 404)

    now = datetime.now(timezone.utc)
    completed_at = now.strftime("%Y-%m-%d %H:%M:%S UTC")
    action["status"] = "completed"
    action["completed_at"] = completed_at
    action["notes"] = notes

    try:
        blob.upload_from_string(
            json.dumps(actions, default=str),
            content_type="application/json",
        )
        logger.info(f"Action {action_id} marked complete in GCS")
    except Exception as e:
        logger.error(f"GCS write failed: {e}")
        return _resp({"status": "error", "message": "Could not save action"}, 500)

    # Create Salesforce Task — non-fatal
    sf_error = None
    try:
        sf = get_sf_client()
        description = action.get("reason", "")
        if notes:
            description += f"\n\nNotes: {notes}"
        sf.Task.create({
            "WhoId": action.get("donor_sf_id"),
            "Subject": f"[FIS] {action.get('label', action_id)}",
            "Status": "Completed",
            "ActivityDate": now.strftime("%Y-%m-%d"),
            "Description": description,
        })
        logger.info(f"SF Task created for action {action_id}, donor {action.get('donor_sf_id')}")
    except Exception as e:
        logger.warning(f"SF Task creation failed (non-fatal): {e}")
        sf_error = str(e)

    response = {"status": "ok", "action_id": action_id, "completed_at": completed_at}
    if sf_error:
        response["sf_warning"] = sf_error
    return _resp(response)
