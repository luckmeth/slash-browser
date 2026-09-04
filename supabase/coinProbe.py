"""SLASH_COIN_PROBE - drives the crediting function as a hostile client.

Every case here is an attack somebody would actually try with a text editor and
five minutes: replay the batch, claim the same hours from a second device, claim
a day of time inside a minute, backdate, post from the future, write the balance
directly. The point is not that the SQL reads correctly; it is that the database
refuses.

The requests go through PostgREST carrying a real signed user JWT - the same
path the browser will take - rather than through the management API as postgres,
because postgres bypasses RLS and would pass every one of these tests while a
real client sailed through.
"""
import json, os, sys, urllib.request, urllib.error, uuid

REF = "edsuuwzihojdsmgzhzyw"
SB = os.environ["SB"]
MGMT = "https://api.supabase.com/v1/projects/%s/database/query" % REF
BASE = "https://%s.supabase.co" % REF


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlashCoinProbe/1.0"


def post(url, body, headers, method="POST"):
    headers = dict(headers)
    headers.setdefault("User-Agent", UA)
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def q(sql):
    """Management API, runs as postgres. Used only to observe, never to test."""
    st, body = post(MGMT, {"query": sql},
                    {"Authorization": "Bearer " + SB, "Content-Type": "application/json"})
    return body


# ---------------------------------------------------------------------------
_st, keys = post("https://api.supabase.com/v1/projects/%s/api-keys?reveal=true" % REF,
                 None, {"Authorization": "Bearer " + SB}, method="GET")
if _st != 200:
    print("could not read api keys:", _st, str(keys)[:300]); sys.exit(1)
ANON = next(k["api_key"] for k in keys if k.get("name") == "anon")
SERVICE = next(k["api_key"] for k in keys if k.get("name") == "service_role")

EMAIL = "slash-coin-probe-%s@example.invalid" % uuid.uuid4().hex[:10]
PASSWORD = uuid.uuid4().hex + "Aa1!"
DEV = "probe-device-aaaaaaaa"
DEV2 = "probe-device-bbbbbbbb"

fails = []


def check(name, got, want):
    ok = got == want
    print("  %s  %s: got %r, want %r" % ("PASS" if ok else "FAIL", name, got, want))
    if not ok:
        fails.append(name)


print("creating probe user via the auth admin API")
st, user = post(BASE + "/auth/v1/admin/users", {
    "email": EMAIL, "password": PASSWORD, "email_confirm": True,
    "user_metadata": {"slash_client": "browser", "full_name": "Coin Probe"},
}, {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE,
    "Content-Type": "application/json"})
if st != 200 or not isinstance(user, dict) or "id" not in user:
    print("could not create probe user:", st, str(user)[:400])
    sys.exit(1)
UID = user["id"]
print("  user", UID)

st, tok = post(BASE + "/auth/v1/token?grant_type=password",
               {"email": EMAIL, "password": PASSWORD},
               {"apikey": ANON, "Content-Type": "application/json"})
if st != 200 or "access_token" not in (tok or {}):
    print("could not sign in:", st, str(tok)[:400])
    post(BASE + "/auth/v1/admin/users/" + UID, None,
         {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE}, method="DELETE")
    sys.exit(1)
JWT = tok["access_token"]
print("  signed in, JWT acquired")

UHEAD = {"apikey": ANON, "Authorization": "Bearer " + JWT, "Content-Type": "application/json"}


def credit(entries):
    st, body = post(BASE + "/rest/v1/rpc/record_coin_intervals", {"entries": entries}, UHEAD)
    if st != 200:
        return {"accepted": -1, "rejected": -1, "credited": -1, "http": st, "err": body}
    return body


def balance():
    st, body = post(BASE + "/rest/v1/coin_balances?select=total", None, UHEAD, method="GET")
    if st != 200 or not body:
        return 0.0
    return float(body[0]["total"])


# ---------------------------------------------------------------------------
print("\n[signup routing]")
prof = q("select count(*) c from profiles where id='%s';" % UID)[0]["c"]
adv = q("select count(*) c from advertisers where auth_user_id='%s';" % UID)[0]["c"]
check("browser signup creates a profile", int(prof), 1)
check("browser signup creates NO advertiser", int(adv), 0)

t = q("select (now() - interval '60 minutes')::text a, (now() - interval '30 minutes')::text b,"
      " (now() - interval '20 minutes')::text c, (now() - interval '10 minutes')::text d,"
      " (now() + interval '2 days')::text fut1, (now() + interval '2 days 1 hour')::text fut2,"
      " (now() - interval '30 days')::text old1,"
      " (now() - interval '30 days' + interval '1 hour')::text old2,"
      " (now() - interval '5 minutes')::text e, (now() - interval '4 minutes')::text f")[0]

print("\n[honest earning]")
r = credit([{"deviceId": DEV, "startedAt": t["a"], "endedAt": t["b"], "seconds": 1800}])
check("30 real minutes accepted", r["accepted"], 1)
check("credits 5.0 coins (10/hour)", float(r["credited"]), 5.0)
check("balance readable by its owner", balance(), 5.0)

print("\n[replay of the same batch]")
r = credit([{"deviceId": DEV, "startedAt": t["a"], "endedAt": t["b"], "seconds": 1800}])
check("replay rejected", r["rejected"], 1)
check("replay credits nothing", float(r["credited"]), 0.0)
check("balance unchanged", balance(), 5.0)

print("\n[same hours from a second device]")
r = credit([{"deviceId": DEV2, "startedAt": t["a"], "endedAt": t["b"], "seconds": 1800}])
check("overlapping device rejected", r["rejected"], 1)
check("balance unchanged", balance(), 5.0)

print("\n[claiming more time than elapsed]")
r = credit([{"deviceId": DEV, "startedAt": t["c"], "endedAt": t["d"], "seconds": 86400}])
check("a day claimed inside 10 minutes rejected", r["rejected"], 1)

print("\n[timestamps outside the window]")
r = credit([{"deviceId": DEV, "startedAt": t["fut1"], "endedAt": t["fut2"], "seconds": 3600}])
check("future interval rejected", r["rejected"], 1)
r = credit([{"deviceId": DEV, "startedAt": t["old1"], "endedAt": t["old2"], "seconds": 3600}])
check("30-day-old interval rejected", r["rejected"], 1)

print("\n[malformed entries do not discard the batch]")
r = credit([
    {"deviceId": DEV, "startedAt": "not-a-date", "endedAt": t["f"], "seconds": 60},
    {"deviceId": "short", "startedAt": t["e"], "endedAt": t["f"], "seconds": 60},
    {"deviceId": DEV, "startedAt": t["e"], "endedAt": t["f"], "seconds": 60},
])
check("one good row survives two bad ones", r["accepted"], 1)
check("both bad rows rejected", r["rejected"], 2)

print("\n[oversized batch]")
bulk = [{"deviceId": DEV, "startedAt": t["e"], "endedAt": t["f"], "seconds": 1}] * 501
r = credit(bulk)
check("a 501-entry batch is refused", r["accepted"], -1)

print("\n[daily cap]")
cap = int(q("select daily_cap_seconds c from coin_config")[0]["c"])
big = q("select (now() - interval '12 hours')::text a, (now() - interval '2 hours')::text b")[0]
r = credit([{"deviceId": DEV, "startedAt": big["a"], "endedAt": big["b"], "seconds": 36000}])
worst = q("select day::text d, sum(qualifying_seconds) s from coin_intervals "
          "where user_id='%s' group by day order by s desc limit 1;" % UID)
print("  busiest day banked %ss against a cap of %ss" % (worst[0]["s"], cap))
check("no day exceeds the cap", int(worst[0]["s"]) <= cap, True)

print("\n[suspended account]")
q("update profiles set suspended = true where id='%s';" % UID)
before = balance()
gap = q("select (now() - interval '3 minutes')::text a, (now() - interval '2 minutes')::text b")[0]
r = credit([{"deviceId": DEV, "startedAt": gap["a"], "endedAt": gap["b"], "seconds": 60}])
check("suspended earns nothing", float(r["credited"]), 0.0)
check("suspended balance frozen", balance(), before)

print("\n[a user cannot un-suspend themselves]")
st, body = post(BASE + "/rest/v1/profiles?id=eq." + UID, {"suspended": False}, UHEAD, method="PATCH")
still = q("select suspended s from profiles where id='%s';" % UID)[0]["s"]
check("self un-suspend refused", bool(still) is True, True)
q("update profiles set suspended = false where id='%s';" % UID)

print("\n[direct writes to the ledger]")
# Captured rather than hardcoded: the cap test above credits a second, larger
# amount, so the honest balance here is not the 5.0 from the first case. An
# assertion written against a stale constant tests the probe, not the ledger.
banked = balance()
rows_before = int(q("select count(*) c from coin_intervals where user_id='%s';" % UID)[0]["c"])
st, body = post(BASE + "/rest/v1/coin_balances", {"user_id": UID, "total": 999999}, UHEAD)
check("a client cannot set its own balance", st >= 400, True)
st, body = post(BASE + "/rest/v1/coin_intervals", {
    "user_id": UID, "device_id": DEV, "started_at": t["old1"], "ended_at": t["old2"],
    "qualifying_seconds": 3600, "claimed_seconds": 3600, "coins": 9999, "day": "2026-08-01",
}, UHEAD)
check("a client cannot write the ledger", st >= 400, True)
st, body = post(BASE + "/rest/v1/coin_intervals?user_id=eq." + UID, None, UHEAD, method="DELETE")
after = int(q("select count(*) c from coin_intervals where user_id='%s';" % UID)[0]["c"])
check("a client cannot delete its ledger", after, rows_before)
check("balance unmoved by every write attempt", balance(), banked)

print("\n[reading someone else's ledger]")
q("insert into coin_balances (user_id, total) select id, 42 from auth.users "
  "where id <> '%s' limit 1 on conflict (user_id) do nothing;" % UID)
st, body = post(BASE + "/rest/v1/coin_balances?select=user_id,total", None, UHEAD, method="GET")
rows = body if isinstance(body, list) else []
check("only own balance row is visible", len(rows), 1)
if rows:
    check("and it is the probe's own", rows[0]["user_id"], UID)
q("delete from coin_balances where user_id <> '%s' and total = 42;" % UID)

print("\n[anonymous callers]")
AHEAD = {"apikey": ANON, "Authorization": "Bearer " + ANON, "Content-Type": "application/json"}
st, body = post(BASE + "/rest/v1/rpc/record_coin_intervals", {"entries": []}, AHEAD)
check("anon cannot call the crediting function", st >= 400, True)
st, body = post(BASE + "/rest/v1/coin_balances?select=total", None, AHEAD, method="GET")
check("anon sees no balances", body if isinstance(body, list) else [], [])
st, body = post(BASE + "/rest/v1/coin_config?select=coins_per_hour", None, AHEAD, method="GET")
check("anon CAN read the public config", st, 200)

print("\nfinal balance %s coins" % balance())
print("cleaning up probe user")
post(BASE + "/auth/v1/admin/users/" + UID, None,
     {"apikey": SERVICE, "Authorization": "Bearer " + SERVICE}, method="DELETE")
left = q("select (select count(*) from coin_intervals where user_id='%s') i, "
         "(select count(*) from profiles where id='%s') p, "
         "(select count(*) from coin_balances where user_id='%s') b;" % (UID, UID, UID))[0]
check("cleanup left nothing behind",
      (int(left["i"]), int(left["p"]), int(left["b"])), (0, 0, 0))

print("")
print("SLASH_COIN_PROBE: all checks passed" if not fails
      else "SLASH_COIN_PROBE: %d FAILED -> %s" % (len(fails), fails))
sys.exit(1 if fails else 0)
