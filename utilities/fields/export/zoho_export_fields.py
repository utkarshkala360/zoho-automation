#!/usr/bin/env python3
"""
Zoho CRM field metadata exporter.

Fill in the CONFIG block below, then run:
    python3 zoho_export_fields.py                      # uses USE_SANDBOX below
    python3 zoho_export_fields.py --env production
    python3 zoho_export_fields.py --env sandbox

For every module listed it writes, into OUTPUT_DIR/<sandbox|production>/:
    <Module>_fields.json   raw API response (everything Zoho returns)
    <Module>_fields.csv    flat sheet: label, API name, type, mandatory, picklist values, lookup ...
    all_fields.csv         every module combined

The access token is cached in ../.zoho_access_token.json (fields_automation/) and
reused across runs; when Zoho rejects it (expired / revoked) a new one is
generated from the refresh token automatically and the call is retried.

No third-party packages needed (standard library only).
"""

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ==================================================
# CONFIG
# ==================================================
# fields/auth/ folder: holds the shared credentials file and token cache
AUTH_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auth")

# Credentials come from fields/auth/zoho_credentials.json (gitignored; copy zoho_credentials.example.json),
# or from the ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN / ZOHO_DATA_CENTER env vars.
CREDENTIALS_FILE = os.path.join(AUTH_DIR, "zoho_credentials.json")
try:
    with open(CREDENTIALS_FILE, encoding="utf-8") as _fh:
        _creds = json.load(_fh)
except (OSError, ValueError):
    _creds = {}

CLIENT_ID = os.environ.get("ZOHO_CLIENT_ID") or _creds.get("client_id")
CLIENT_SECRET = os.environ.get("ZOHO_CLIENT_SECRET") or _creds.get("client_secret")
REFRESH_TOKEN = os.environ.get("ZOHO_REFRESH_TOKEN") or _creds.get("refresh_token")

# Data centre of the Zoho account: "in", "com", "eu", "com.au", "jp", "ca", "sa", "com.cn"
DATA_CENTER = os.environ.get("ZOHO_DATA_CENTER") or _creds.get("data_center") or "in"

if not (CLIENT_ID and CLIENT_SECRET and REFRESH_TOKEN):
    sys.exit(f"ERROR: Zoho credentials missing: fill in {CREDENTIALS_FILE} or set ZOHO_* env vars")

# Default org when --env is not passed:
# True -> sandbox (sandbox.zohoapis.<dc>), False -> production (www.zohoapis.<dc>)
USE_SANDBOX = True

# Module API names. Use ["ALL"] to export every API-supported module in the org.
MODULES = ["Leads", "Contacts", "Calls"]

API_VERSION = "v8"
# Exports go next to this script: export/zoho_fields_output/<sandbox|production>/
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zoho_fields_output")

# Access token is cached in fields/auth/ (shared with the JS scripts),
# reused until Zoho rejects it, then auto-rotated
TOKEN_CACHE_FILE = os.path.join(AUTH_DIR, ".zoho_access_token.json")


# ==================================================
# HTTP HELPERS
# ==================================================
class AuthError(RuntimeError):
    pass


def http_request(url, method="GET", headers=None, data=None, json_body=None):
    headers = dict(headers or {})
    body = None
    if json_body is not None:
        body = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif data:
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        if e.code == 401 or "INVALID_TOKEN" in detail or "AUTHENTICATION_FAILURE" in detail:
            raise AuthError(f"HTTP {e.code} on {url}\n{detail}") from None
        raise RuntimeError(f"HTTP {e.code} on {url}\n{detail}") from None


# ==================================================
# ACCESS TOKEN (cached locally, auto-rotated)
# ==================================================
def load_cached_token():
    try:
        with open(TOKEN_CACHE_FILE, encoding="utf-8") as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        return None
    # Ignore a token cached for a different client / data centre
    if cache.get("client_id") != CLIENT_ID or cache.get("data_center") != DATA_CENTER:
        return None
    return cache.get("access_token")


def save_cached_token(token, expires_in):
    cache = {
        "access_token": token,
        "client_id": CLIENT_ID,
        "data_center": DATA_CENTER,
        "created_at": int(time.time()),
        "expires_in": expires_in,
    }
    with open(TOKEN_CACHE_FILE, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, indent=2)
    try:
        os.chmod(TOKEN_CACHE_FILE, 0o600)
    except OSError:
        pass


def refresh_access_token():
    url = f"https://accounts.zoho.{DATA_CENTER}/oauth/v2/token"
    resp = http_request(url, method="POST", data={
        "refresh_token": REFRESH_TOKEN,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
    })
    token = resp.get("access_token")
    if not token:
        raise RuntimeError(f"Could not get access token: {resp}")
    save_cached_token(token, resp.get("expires_in"))
    print("  ↻ New access token generated and cached")
    return token


_access_token = None


def get_access_token(force_refresh=False):
    global _access_token
    if force_refresh:
        _access_token = refresh_access_token()
    elif _access_token is None:
        _access_token = load_cached_token() or refresh_access_token()
    return _access_token


def env_name():
    return "sandbox" if USE_SANDBOX else "production"


def apply_env_arg(argv=None):
    """Honour `--env sandbox|production` on the command line (overrides USE_SANDBOX)."""
    global USE_SANDBOX
    argv = sys.argv[1:] if argv is None else argv
    if "--env" in argv:
        i = argv.index("--env")
        value = argv[i + 1].lower() if i + 1 < len(argv) else ""
        if value not in ("sandbox", "production", "prod"):
            sys.exit("ERROR: --env must be 'sandbox' or 'production'")
        USE_SANDBOX = value == "sandbox"


def api_request(method, path, params=None, json_body=None):
    host = "sandbox.zohoapis" if USE_SANDBOX else "www.zohoapis"
    url = f"https://{host}.{DATA_CENTER}/crm/{API_VERSION}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    try:
        return http_request(url, method=method, json_body=json_body,
                            headers={"Authorization": f"Zoho-oauthtoken {get_access_token()}"})
    except AuthError:
        # Cached / current token expired or revoked -> rotate once and retry
        token = get_access_token(force_refresh=True)
        return http_request(url, method=method, json_body=json_body,
                            headers={"Authorization": f"Zoho-oauthtoken {token}"})


def api_get(path, params=None):
    return api_request("GET", path, params)


# ==================================================
# EXPORT
# ==================================================
CSV_COLUMNS = [
    "module", "field_label", "api_name", "data_type", "json_type", "length",
    "system_mandatory", "custom_field", "read_only", "unique",
    "lookup_module", "picklist_values", "default_value", "formula", "id",
]


def list_all_modules():
    modules = api_get("settings/modules").get("modules", [])
    return [m["api_name"] for m in modules if m.get("api_supported")]


def flatten_field(module, f):
    picklist = f.get("pick_list_values") or []
    lookup = (f.get("lookup") or {}).get("module") or {}
    formula = f.get("formula") or {}
    return {
        "module": module,
        "field_label": f.get("field_label", ""),
        "api_name": f.get("api_name", ""),
        "data_type": f.get("data_type", ""),
        "json_type": f.get("json_type", ""),
        "length": f.get("length", ""),
        "system_mandatory": f.get("system_mandatory", ""),
        "custom_field": f.get("custom_field", ""),
        "read_only": f.get("read_only", ""),
        "unique": bool((f.get("unique") or {}).get("casesensitive")) if isinstance(f.get("unique"), dict) else f.get("unique", ""),
        "lookup_module": lookup.get("api_name", "") if isinstance(lookup, dict) else lookup,
        "picklist_values": " | ".join(str(p.get("actual_value", p.get("display_value", ""))) for p in picklist),
        "default_value": f.get("default_value", "") or "",
        "formula": formula.get("expression", "") if isinstance(formula, dict) else "",
        "id": f.get("id", ""),
    }


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    apply_env_arg()
    out_dir = os.path.join(OUTPUT_DIR, env_name())
    os.makedirs(out_dir, exist_ok=True)
    print(f"Org : {env_name()}")

    modules = list_all_modules() if [m.upper() for m in MODULES] == ["ALL"] else MODULES
    all_rows = []

    for module in modules:
        try:
            resp = api_get("settings/fields", {"module": module})
        except RuntimeError as e:
            print(f"  ✗ {module}: {e}")
            continue

        fields = resp.get("fields", [])
        with open(os.path.join(out_dir, f"{module}_fields.json"), "w", encoding="utf-8") as fh:
            json.dump(resp, fh, indent=2, ensure_ascii=False)

        rows = [flatten_field(module, f) for f in fields]
        write_csv(os.path.join(out_dir, f"{module}_fields.csv"), rows)
        all_rows.extend(rows)
        print(f"  ✓ {module}: {len(fields)} fields")

    write_csv(os.path.join(out_dir, "all_fields.csv"), all_rows)
    print(f"\nDone. {len(all_rows)} fields written to {os.path.abspath(out_dir)}")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(f"ERROR: {e}")
