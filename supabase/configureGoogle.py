"""Point Supabase at a Google OAuth client, then prove the handshake works.

Google has no public API for creating a general-purpose OAuth client - the only
programmatic route is the IAP one, which is locked to IAP usage and cannot set a
redirect URI - so creating the client is console work. Everything after it is
not, and this does the rest in one command.

Usage:

    SB=<supabase management token> python supabase/configureGoogle.py \
        --client-id <...>.apps.googleusercontent.com \
        --client-secret GOCSPX-...

Add --check on its own to test the current configuration without changing it.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

REF = "edsuuwzihojdsmgzhzyw"
BASE = "https://%s.supabase.co" % REF
MGMT = "https://api.supabase.com/v1/projects/%s/config/auth" % REF
CALLBACK = "%s/auth/v1/callback" % BASE
LOOPBACK = "http://127.0.0.1:*/callback,http://localhost:*/callback"

# Cloudflare rejects urllib's default agent outright.
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlashSetup/1.0"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(url, token=None, body=None, method="GET"):
    headers = {"User-Agent": UA}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw)
        except Exception:
            return error.code, raw


def hop(url):
    """One redirect hop, without following it."""
    opener = urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        response = opener.open(req)
        return response.status, "", response.read().decode("utf8", "ignore")
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("Location", ""), error.read().decode("utf8", "ignore")


def verify():
    """Walk the real authorize chain and report where it ends up.

    This is the whole point of the script. A configuration that *looks* right
    still fails if the Google client is the wrong type, and the only way to know
    is to make the request Google will actually receive.
    """
    url = (
        BASE
        + "/auth/v1/authorize?provider=google&redirect_to="
        + urllib.parse.quote("http://127.0.0.1:9999/callback", safe="")
    )
    seen = []
    for _ in range(5):
        status, location, body = hop(url)
        seen.append((status, location or "(final page)"))
        if not location:
            lowered = body.lower()
            if "redirect_uri_mismatch" in lowered:
                return False, "redirect_uri_mismatch", seen
            if "invalid_client" in lowered or "deleted_client" in lowered:
                return False, "invalid_client", seen
            if "error 400" in lowered or "access blocked" in lowered:
                return False, "google refused the request", seen
            return True, "reached a Google page with no error", seen
        if "redirect_uri_mismatch" in location:
            return False, "redirect_uri_mismatch", seen
        if "accounts.google.com/signin" in location and "error" not in location:
            return True, "reached Google's sign-in", seen
        url = location
    return False, "too many redirects", seen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id")
    parser.add_argument("--client-secret")
    parser.add_argument("--token", help="Supabase management token; or set SB")
    parser.add_argument("--check", action="store_true", help="verify only, change nothing")
    args = parser.parse_args()

    import os

    token = args.token or os.environ.get("SB", "")
    if not token:
        print("no management token: pass --token or set SB")
        return 1

    if not args.check:
        if not args.client_id or not args.client_secret:
            print("pass --client-id and --client-secret, or --check to test only")
            return 1
        if "apps.googleusercontent.com" not in args.client_id:
            print("that does not look like a Google client id")
            return 1

        print("configuring Supabase...")
        status, body = request(
            MGMT,
            token,
            {
                "external_google_enabled": True,
                "external_google_client_id": args.client_id,
                "external_google_secret": args.client_secret,
                # The loopback listener in RewardsService receives the code from
                # Supabase, so these must stay allowed however Google is set up.
                "uri_allow_list": LOOPBACK,
            },
            method="PATCH",
        )
        if status != 200:
            print("  FAILED: %s %s" % (status, str(body)[:300]))
            return 1
        print("  google enabled, client set, loopback allowed")

    status, config = request(MGMT, token)
    if status != 200:
        print("could not read the auth config: %s" % status)
        return 1
    print("")
    print("google enabled : %s" % config.get("external_google_enabled"))
    print("client id      : %s" % (config.get("external_google_client_id") or "(none)"))
    print("secret set     : %s" % bool(config.get("external_google_secret")))
    print("allow list     : %s" % config.get("uri_allow_list"))
    print("callback Google must permit:")
    print("  %s" % CALLBACK)

    print("")
    print("verifying the handshake against Google...")
    ok, reason, seen = verify()
    for status_code, where in seen:
        print("  %s -> %s" % (status_code, where[:96]))

    print("")
    if ok:
        print("PASS - %s. Sign-in should now work from the browser." % reason)
        return 0

    print("FAIL - %s" % reason)
    if reason == "redirect_uri_mismatch":
        print("")
        print("The client is almost certainly a **Desktop app** client. Google")
        print("will not accept an https redirect for those, and the console does")
        print("not offer the field. Create a **Web application** client with this")
        print("authorised redirect URI, then re-run:")
        print("  %s" % CALLBACK)
    return 1


if __name__ == "__main__":
    sys.exit(main())
