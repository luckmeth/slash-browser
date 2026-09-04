"""SLASH_ADVERTISE_PROBE - books a campaign the way the browser does.

Every request here goes through PostgREST carrying a real signed user JWT, on a
throwaway account created for the run and deleted at the end. That is the whole
point: the management API runs as `postgres`, bypasses row-level security and
every column grant, and would pass each of these while a real client was
refused - which is exactly what happened. Submitting a campaign from the
browser failed with "permission denied" for a week of code that typechecked,
passed 1,436 unit tests and built cleanly, because `status` is not one of the
eight columns an advertiser may insert.

It checks the path works, and then that the ways it must fail still do.

  SB=<supabase management token> python supabase/advertiseProbe.py
"""
import json, os, sys, time, urllib.request, urllib.error, uuid

REF = "edsuuwzihojdsmgzhzyw"
BASE = "https://%s.supabase.co" % REF
ENV = os.path.join(os.path.dirname(__file__), "..", "platform", "admin", ".env.local")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlashAdvertiseProbe/1.0"


def env():
    """Keys from the admin app's own env file, which is where they already live."""
    values = {}
    with open(ENV, encoding="utf-8") as handle:
        for line in handle:
            if "=" in line and not line.strip().startswith("#"):
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    return values


def request(url, body, headers, method="POST", raw=None):
    headers = dict(headers)
    headers.setdefault("User-Agent", UA)
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            text = response.read().decode()
            return response.status, (json.loads(text) if text.strip() else None)
    except urllib.error.HTTPError as error:
        text = error.read().decode()
        try:
            return error.code, json.loads(text)
        except Exception:
            return error.code, text


KEYS = env()
ANON = KEYS["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE = KEYS["SUPABASE_SERVICE_ROLE_KEY"]

EMAIL = "advertise-probe-%s@slash.invalid" % uuid.uuid4().hex[:10]
PASSWORD = "Probe!" + uuid.uuid4().hex[:16]

passed, failed = [], []


def check(name, condition, detail=""):
    (passed if condition else failed).append(name)
    print(("  PASS  " if condition else "  FAIL  ") + name + (("   " + str(detail)[:220]) if detail else ""))


print("SLASH_ADVERTISE_PROBE")
print("=" * 72)

# --- a real account, signed in the way a person is ------------------------
status, user = request(
    BASE + "/auth/v1/admin/users",
    {"email": EMAIL, "password": PASSWORD, "email_confirm": True},
    {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json"},
)
if status >= 300:
    print("could not create the probe account:", status, user)
    sys.exit(1)
UID = user["id"]

status, token = request(
    BASE + "/auth/v1/token?grant_type=password",
    {"email": EMAIL, "password": PASSWORD},
    {"apikey": ANON, "Content-Type": "application/json"},
)
if status >= 300:
    print("could not sign in:", status, token)
    sys.exit(1)
JWT = token["access_token"]

USER = {"apikey": ANON, "Authorization": "Bearer " + JWT, "Content-Type": "application/json"}
ADMIN = {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json"}


def rest(path, body=None, method="POST", headers=None, raw=None, content_type=None):
    head = dict(headers or USER)
    if content_type:
        head["Content-Type"] = content_type
    return request(BASE + "/rest/v1/" + path, body, head, method, raw)


try:
    # --- the browser marks the account, which deletes the advertiser row ---
    status, _ = rest("rpc/mark_browser_account", {}, headers=USER)
    check("the browser can mark its own account", status < 300, status)

    status, rows = rest("advertisers?select=id", None, "GET", USER)
    check("no advertiser row survives that, as designed", rows == [], rows)

    # --- the company profile, through the function ------------------------
    status, _ = rest(
        "rpc/save_advertiser_profile",
        {"details": {"companyName": "Probe Co", "contactEmail": EMAIL, "website": "https://probe.test",
                     "city": "Colombo", "country": "LK"}},
        headers=USER,
    )
    check("a company profile can be created from the browser", status < 300, status)

    status, rows = rest("advertisers?select=id,company_name,website,status,profile_updated_at", None, "GET", USER)
    company = rows[0] if isinstance(rows, list) and rows else None
    check("it reads back", company is not None and company["company_name"] == "Probe Co", rows)
    check("and counts as filled in", company and company["profile_updated_at"] is not None)
    ADVERTISER_ID = company["id"] if company else None

    status, _ = rest(
        "rpc/save_advertiser_profile",
        {"details": {"companyName": "Probe Co", "website": "http://insecure.test"}},
        headers=USER,
    )
    check("an http website is refused", status >= 400, status)

    status, _ = rest("rpc/save_advertiser_profile", {"details": {"companyName": "  "}}, headers=USER)
    check("an empty company name is refused", status >= 400, status)

    # --- signing in again must not delete the profile ---------------------
    rest("rpc/mark_browser_account", {}, headers=USER)
    status, rows = rest("advertisers?select=id", None, "GET", USER)
    check("a filled-in profile survives the next sign-in", rows and len(rows) == 1, rows)

    # --- the creative ------------------------------------------------------
    PNG = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000a49444154789c6360000002000100ffff03000006000557bfabd4000000"
        "0049454e44ae426082"
    )
    path = "%s/%d.png" % (UID, int(time.time()))
    status, body = request(
        BASE + "/storage/v1/object/campaign-assets/" + path,
        None,
        {"apikey": ANON, "Authorization": "Bearer " + JWT, "Content-Type": "image/png"},
        "POST",
        raw=PNG,
    )
    check("a creative uploads to the advertiser's own folder", status < 300, body)

    status, body = request(
        BASE + "/storage/v1/object/campaign-assets/" + "00000000-0000-0000-0000-000000000000/evil.png",
        None,
        {"apikey": ANON, "Authorization": "Bearer " + JWT, "Content-Type": "image/png"},
        "POST",
        raw=PNG,
    )
    check("but not into somebody else's folder", status >= 400, status)

    # --- the campaign, exactly as AdvertiserService sends it --------------
    # One epoch base for both ends. The first version of this took `mktime` of
    # a UTC struct, which reads it as local time -- so the window was six hours
    # short and the probe reported the *server* as mispricing. A probe that
    # accuses the thing it is testing is worse than no probe.
    base = (int(time.time()) + 48 * 3600) // 3600 * 3600
    starts_at = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(base))
    ends_at = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(base + 72 * 3600))

    status, rows = rest("pricing_config?select=placement_tier,hourly_rate,min_hours&active=eq.true", None, "GET", USER)
    tier = rows[0] if isinstance(rows, list) and rows else None
    check("the rate card is readable while signed in", tier is not None, rows)

    campaign = {
        "advertiser_id": ADVERTISER_ID,
        "title": "Probe campaign",
        "description": "A probe.",
        "destination_link": "https://probe.test/offer",
        "placement_tier": tier["placement_tier"] if tier else "home_banner",
        "image_path": path,
        "starts_at": starts_at,
        "ends_at": ends_at,
    }
    status, created = rest("campaigns", campaign, headers={**USER, "Prefer": "return=representation"})
    check("a campaign submits", status < 300, created)
    CAMPAIGN_ID = created[0]["id"] if status < 300 and created else None

    if CAMPAIGN_ID:
        row = created[0]
        check("it lands in the review queue", row["status"] == "pending_review", row["status"])
        expected = round(72 * float(tier["hourly_rate"]), 2)
        check("the server priced it, not the client", abs(float(row["total_cost"]) - expected) < 0.01,
              "%s vs %s" % (row["total_cost"], expected))
        check("the creative is attached", row["image_path"] == path, row["image_path"])

    # --- and the ways it must fail ---------------------------------------
    status, body = rest("campaigns", {**campaign, "status": "active"}, headers=USER)
    check("a client cannot state its own status", status >= 400, body)

    status, body = rest("campaigns", {**campaign, "total_cost": 0.01}, headers=USER)
    check("a client cannot state its own price", status >= 400, body)

    status, body = rest(
        "campaigns",
        {**campaign, "advertiser_id": "00000000-0000-0000-0000-000000000000"},
        headers=USER,
    )
    check("a client cannot book for another advertiser", status >= 400, body)

    half = {**campaign, "ends_at": starts_at.replace(":00:00Z", ":30:00Z")}
    status, body = rest("campaigns", half, headers=USER)
    check("a fractional hour is refused", status >= 400, body)

    short = dict(campaign)
    short["ends_at"] = time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(base + 2 * 3600))
    status, body = rest("campaigns", short, headers=USER)
    check("under the minimum block is refused", status >= 400, body)

    status, body = rest("advertisers?id=eq.%s" % ADVERTISER_ID, {"status": "suspended"}, "PATCH", USER)
    still = rest("advertisers?select=status", None, "GET", USER)[1]
    check("an advertiser cannot suspend or unsuspend themselves",
          status >= 400 or (still and still[0]["status"] == "active"), still)

    # --- what an operator sees -------------------------------------------
    status, rows = request(
        BASE + "/rest/v1/campaigns?select=id,title,status,advertisers(company_name)&status=eq.pending_review",
        None, ADMIN, "GET")
    mine = [row for row in (rows or []) if row["id"] == CAMPAIGN_ID]
    check("the operator sees it, with the company", bool(mine) and mine[0]["advertisers"]["company_name"] == "Probe Co", mine)

finally:
    # --- clean up, whatever happened -------------------------------------
    request(BASE + "/rest/v1/campaigns?advertiser_id=eq." + str(locals().get("ADVERTISER_ID")),
            None, ADMIN, "DELETE")
    request(BASE + "/rest/v1/advertisers?auth_user_id=eq." + UID, None, ADMIN, "DELETE")
    request(BASE + "/auth/v1/admin/users/" + UID, None,
            {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE}, "DELETE")
    print("\ncleaned up the probe account")

print("=" * 72)
print("%d passed, %d failed" % (len(passed), len(failed)))
if failed:
    print("failed:")
    for name in failed:
        print("  - " + name)
sys.exit(1 if failed else 0)
