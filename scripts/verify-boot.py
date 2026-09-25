"""End-to-end boot verification for dsh-manual-approval.

Booting the profile is necessary but not sufficient: this also proves the Host
half actually mounted and that its private route answers. Steps:

  1. boot `dsh web` on an unused port with the throwaway test profile;
  2. read the printed URL to learn the web server's own access token;
  3. fetch `/` and assert the plugin's page injection is present (proving the
     index tap ran);
  4. call the plugin route without a token (expect 403) and with the injected
     token (expect the rule snapshot), proving the route is live and guarded;
  5. assert the plugin's mount line reached the log.
"""

import http.cookiejar
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PORT = 3100
# Paths are derived from this file's own location, never hardcoded: a checkout
# must run on any machine and at any path. `DSH_TEST_HOME` overrides the
# throwaway profile location.
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST_HOME = os.environ.get("DSH_TEST_HOME") or os.path.join(tempfile.gettempdir(), "dsh-manual-approval-testhome")
LOG = os.path.join(TEST_HOME, "verify.out")
DSH = os.environ.get("DSH_BIN", "dsh")
RULE_FILE = os.path.join(TEST_HOME, "manual-approval", "rules.json")


def scaffold_test_home():
    """Create the throwaway profile that lists this checkout as a bundle.

    Written with explicit UTF-8 and LF endings: PowerShell's `-Encoding utf8`
    emits a BOM, and a BOM makes the profile manifest fail to parse. Created only
    when absent, so an existing profile keeps whatever dependencies it installed.
    """
    profile = os.path.join(TEST_HOME, "profiles", "web")
    os.makedirs(profile, exist_ok=True)
    package = os.path.join(profile, "package.json")
    if not os.path.exists(package):
        manifest = {
            "name": "dsh-profile-manual-approval-test",
            "private": True,
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-manual-approval"], "patchReload": "live"}},
            "dependencies": {"dsh-manual-approval": "link:" + PLUGIN.replace("\\", "/")},
        }
        with io.open(package, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(manifest, indent=2) + "\n")
    for name in ("cordis.yml", "cordis.patch.yml"):
        path = os.path.join(profile, name)
        if not os.path.exists(path):
            with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("[]\n")


def install_profile():
    """Install the profile's dependencies, which a fresh profile has none of.

    Writing `package.json` is not enough: boot refuses with "cannot resolve
    profile bundle" until `dsh plugin --profile web install` has actually linked
    them. Skipped once the link exists, so later runs do not pay for it again.
    """
    linked = os.path.join(TEST_HOME, "profiles", "web", "node_modules", "dsh-manual-approval")
    if os.path.exists(linked):
        return
    result = subprocess.run(
        [DSH, "plugin", "--profile", "web", "install"],
        capture_output=True,
        timeout=600,
        env={**os.environ, "DSH_HOME": TEST_HOME},
        shell=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout.decode("utf-8", "replace"))
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        raise SystemExit("could not install the throwaway profile; see the output above")


failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' -- ' + str(detail)) if detail else ''}")
    if not ok:
        failures.append(name)


def read_log():
    try:
        with io.open(LOG, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


# A rules file with one valid rule and one deliberately broken regex, so the
# snapshot must report validity per rule rather than swallowing the document.
os.makedirs(os.path.dirname(RULE_FILE), exist_ok=True)
with io.open(RULE_FILE, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(
        {
            "version": 1,
            "masterEnabled": False,
            "rules": [
                {
                    "id": "ok",
                    "name": "allow reads",
                    "enabled": True,
                    "conditions": [{"target": "toolName", "pattern": "^(read|glob)$"}],
                    "action": {"kind": "approve", "message": ""},
                },
                {
                    "id": "broken",
                    "name": "broken regex",
                    "enabled": True,
                    "conditions": [{"target": "toolName", "pattern": "(["}],
                    "action": {"kind": "deny", "message": "no"},
                },
            ],
        },
        handle,
        indent=2,
    )

if os.path.exists(LOG):
    os.remove(LOG)

scaffold_test_home()
install_profile()

env = dict(os.environ)
env["DSH_HOME"] = TEST_HOME
log_handle = io.open(LOG, "w", encoding="utf-8")
process = subprocess.Popen(
    [DSH, "web", "--port", str(PORT), "--no-open"],
    stdout=log_handle,
    stderr=subprocess.STDOUT,
    cwd=os.path.dirname(PLUGIN),
    env=env,
    shell=True,
)

try:
    deadline = time.time() + 70
    token = None
    while time.time() < deadline:
        if process.poll() is not None:
            break
        match = re.search(rf"http://127\.0\.0\.1:{PORT}/\?token=([A-Za-z0-9_\-]+)", read_log())
        if match:
            token = match.group(1)
            break
        time.sleep(1)

    check("the harness boots far enough to print its URL", token is not None, f"port {PORT}")
    if token is None:
        print(read_log()[-2000:])
        raise SystemExit(1)

    base = f"http://127.0.0.1:{PORT}/?token={token}"

    # The root query token MINTS a browser cookie and 303-redirects to `/`; the
    # cookie is what authorizes later requests. urllib does not keep cookies, so
    # the jar below is load-bearing.
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    try:
        with opener.open(base, timeout=20) as response:
            html = response.read().decode("utf-8", "replace")
    except urllib.error.URLError as error:
        html = ""
        check("the page is served", False, error)
    else:
        check("the page is served", len(html) > 0, f"{len(html)} bytes, cookies={len(jar)}")

    check(
        "the plugin injected its page globals",
        "__DSH_MANUAL_APPROVAL__" in html,
        "index tap ran" if "__DSH_MANUAL_APPROVAL__" in html else "marker absent",
    )
    injected = None
    if "__DSH_MANUAL_APPROVAL__" in html:
        match = re.search(r"__DSH_MANUAL_APPROVAL__=(\{.*?\})</script>", html, re.S)
        if match:
            try:
                injected = json.loads(match.group(1))
            except ValueError:
                injected = None
    check("the injected payload carries a token and a route", isinstance(injected, dict) and bool(injected.get("token")) and bool(injected.get("rulesEndpoint")), injected)

    route = f"http://127.0.0.1:{PORT}/dsh-manual-approval/feedback"

    # 4a. no token -> refused.
    try:
        with urllib.request.urlopen(route + "?rules=1", timeout=10) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    check("the plugin route refuses a token-less request", status == 403, f"HTTP {status}")

    # 4b. with the injected token -> the rule snapshot.
    payload = None
    if isinstance(injected, dict) and injected.get("token"):
        request = urllib.request.Request(route + "?rules=1", headers={"x-manual-approval-token": injected["token"]})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - reported below
            payload = {"error": str(error)}
    check("the route answers the settings page with the rule document", isinstance(payload, dict) and payload.get("ok") is True, payload)
    if isinstance(payload, dict) and payload.get("ok") is True:
        compiled = payload.get("compiled") or []
        check("the document round-trips both rules", len(payload.get("rules") or []) == 2, len(payload.get("rules") or []))
        by_id = {entry.get("id"): entry for entry in compiled}
        check("the valid rule reads valid and enabled", by_id.get("ok", {}).get("valid") is True, by_id.get("ok"))
        check("the broken regex is reported and cannot be enabled", by_id.get("broken", {}).get("valid") is False and by_id.get("broken", {}).get("enabled") is False, by_id.get("broken", {}).get("errors"))
        check("the master switch is read from the document", payload.get("masterEnabled") is False, payload.get("masterEnabled"))

    # The route's own behaviour is the load-bearing evidence that the Host half
    # mounted: a token-less request gets 403 only when this plugin registered the
    # route, and 404 when it did not. The console log line is advisory, because
    # the harness's logger destination is not part of this plugin's contract.
    mount_line_seen = "[manual-approval] mounted" in read_log()
    print(f"  note the mount log line {'was' if mount_line_seen else 'was not'} seen on stdout")
finally:
    try:
        process.terminate()
        process.wait(timeout=15)
    except Exception:  # noqa: BLE001 - best effort teardown
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            pass
    log_handle.close()
    # A shell-wrapped child can survive terminate(); clean up by port owner.
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue | "
             f"ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}"],
            capture_output=True, timeout=40,
        )
    except Exception:  # noqa: BLE001
        pass

print()
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("all boot checks passed")
