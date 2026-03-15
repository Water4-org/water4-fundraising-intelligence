"""
auth_server/main.py — FIS Dashboard with Google OAuth.

Routes:
  GET /auth/login    → redirect to Google OAuth (restricted to water4.org)
  GET /auth/callback → exchange code, create session cookie
  GET /auth/logout   → clear cookie, redirect to /
  GET /api/me        → return session info or 401
  GET /*             → serve React app (requires valid session)
"""

import os
import json
import logging
import httpx
import jwt
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from google.cloud import secretmanager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(docs_url=None, redoc_url=None)

# ── Secret loading ─────────────────────────────────────────────────────────────

_secrets: dict[str, str] = {}

def get_secret(name: str) -> str:
    if name not in _secrets:
        client = secretmanager.SecretManagerServiceClient()
        project = os.getenv("GCP_PROJECT", "water4-org")
        path = f"projects/{project}/secrets/{name}/versions/latest"
        _secrets[name] = client.access_secret_version(name=path).payload.data.decode().strip()
    return _secrets[name]

# ── Config ─────────────────────────────────────────────────────────────────────

GOOGLE_AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL    = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"
ALLOWED_DOMAIN      = "water4.org"
SESSION_COOKIE      = "fis_session"
SESSION_HOURS       = 8

STATIC_EXTENSIONS   = {".js", ".css", ".ico", ".png", ".svg", ".woff", ".woff2", ".map"}
EXEMPT_PATHS        = {"/auth/login", "/auth/callback", "/auth/logout", "/api/me"}
ADMIN_EMAILS        = {"matt@water4.org", "matt.woll@water4.org", "mattwoll@water4.org"}
DONOR_SERVICES_EMAIL = "ds.qualify@water4.org"

# Name overrides: force specific display names regardless of Google profile
NAME_OVERRIDES      = {DONOR_SERVICES_EMAIL: "Donor Services"}

# ── Session helpers ────────────────────────────────────────────────────────────

def _redirect_uri(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host  = request.headers.get("x-forwarded-host", request.url.netloc)
    return f"{proto}://{host}/auth/callback"

def _make_token(user: dict) -> str:
    payload = {**user, "exp": datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)}
    return jwt.encode(payload, get_secret("FIS_SESSION_SECRET"), algorithm="HS256")

def _decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, get_secret("FIS_SESSION_SECRET"), algorithms=["HS256"])
    except Exception:
        return None

def _session(request: Request) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE)
    return _decode_token(token) if token else None

# ── Salesforce user lookup ─────────────────────────────────────────────────────

def _sf_user_id(email: str) -> str:
    """Return the Salesforce User ID for a given email, or '' if not found."""
    try:
        from simple_salesforce import Salesforce
        creds = json.loads(get_secret("SF_CREDENTIALS"))
        sf = Salesforce(
            username=creds["username"],
            password=creds["password"],
            security_token=creds["security_token"],
            domain=creds.get("domain", "login"),
        )
        result = sf.query(f"SELECT Id FROM User WHERE Email = '{email}' AND IsActive = true LIMIT 1")
        if result["records"]:
            return result["records"][0]["Id"]
    except Exception as e:
        logger.warning(f"SF user lookup failed for {email}: {e}")
    return ""

# ── Auth routes ────────────────────────────────────────────────────────────────

@app.get("/auth/login")
async def login(request: Request):
    params = {
        "client_id":     get_secret("GOOGLE_CLIENT_ID"),
        "redirect_uri":  _redirect_uri(request),
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "online",
        "hd":            ALLOWED_DOMAIN,
    }
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{qs}")


@app.get("/auth/callback")
async def callback(request: Request, code: str = None, error: str = None):
    if error or not code:
        return HTMLResponse(f"<h2>Login failed: {error or 'no code'}</h2>", status_code=400)

    # Exchange code for access token
    async with httpx.AsyncClient() as client:
        token_resp = await client.post(GOOGLE_TOKEN_URL, data={
            "code":          code,
            "client_id":     get_secret("GOOGLE_CLIENT_ID"),
            "client_secret": get_secret("GOOGLE_CLIENT_SECRET"),
            "redirect_uri":  _redirect_uri(request),
            "grant_type":    "authorization_code",
        })
        tokens = token_resp.json()

    if "error" in tokens:
        return HTMLResponse(f"<h2>Token error: {tokens['error']}</h2>", status_code=400)

    # Get user info from Google
    async with httpx.AsyncClient() as client:
        info_resp = await client.get(GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}"})
        info = info_resp.json()

    email = info.get("email", "")
    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        return HTMLResponse(
            f"<h2>Access denied.</h2><p>Only @{ALLOWED_DOMAIN} accounts may access this dashboard.</p>",
            status_code=403,
        )

    sf_id = _sf_user_id(email)
    name = NAME_OVERRIDES.get(email, info.get("name", ""))
    session = {"email": email, "name": name, "picture": info.get("picture", ""), "sf_user_id": sf_id}
    logger.info(f"Login: {email} (SF: {sf_id or 'not found'})")

    resp = RedirectResponse("/", status_code=302)
    resp.set_cookie(SESSION_COOKIE, _make_token(session),
                    max_age=SESSION_HOURS * 3600, httponly=True, secure=True, samesite="lax")
    return resp


@app.get("/auth/logout")
async def logout():
    resp = RedirectResponse("/", status_code=302)
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/me")
async def me(request: Request):
    s = _session(request)
    if not s:
        return JSONResponse({"authenticated": False}, status_code=401)
    email = s.get("email", "")
    name = NAME_OVERRIDES.get(email, s.get("name"))
    return JSONResponse({"authenticated": True, "email": email, "name": name,
                         "picture": s.get("picture"), "sf_user_id": s.get("sf_user_id", ""),
                         "is_admin": email in ADMIN_EMAILS,
                         "is_donor_services": email == DONOR_SERVICES_EMAIL})

# ── Auth middleware ────────────────────────────────────────────────────────────

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in EXEMPT_PATHS or any(path.endswith(e) for e in STATIC_EXTENSIONS):
            return await call_next(request)
        if not _session(request):
            return RedirectResponse("/auth/login", status_code=302)
        return await call_next(request)

app.add_middleware(AuthMiddleware)

# Mount React build last (catch-all for SPA routing)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
