# Troubleshooting SpendSense

Start with the symptom below. Keep the same Hermes connection and profile while
checking an existing installation. Do not uninstall SpendSense, clear Desktop
storage, delete ledgers or reset profiles to fix an old UI.

## Installer shows the right pin, but Desktop shows an older UI

The pin records the requested repository revision. It does not prove which
JavaScript file Desktop loads, or which backend code is running.

1. Let any installation finish. Fully quit and reopen Hermes Desktop (Command-Q
   on macOS; use Quit/Exit on Windows or Linux, including any tray instance).
2. Confirm the selected connection and profile. With a remote backend, the UI
   file is on the Desktop machine and the backend files are on the server.
3. If the UI is still old, compare its actual installed file with the approved
   revision and the running backend's expected Desktop hash. See
   [advanced verification](#advanced-verification-and-repair).
4. Prefer Hermes' normal reinstall/rescan controls for that same approved
   revision. If they leave a proven stale file, use the
   [targeted repair](#replace-only-a-proven-stale-desktop-file) below.

Some Hermes builds reconcile installed Desktop halves using source timestamps.
That can retain different bytes when the recorded source timestamp is as new as
or newer than the package's. This is a supported explanation for a stale copy,
not proof of the cause of every stale UI. See
[upstream PR #154773](https://github.com/NousResearch/hermes-agent/pull/154773).
Check the Hermes build you actually use; do not assume the fix is included.

## “SpendSense halves are from different releases”

This means the UI cannot safely use the backend it reached. Avoid editing
memberships, budgets or settings until the pair agrees. Detecting the mismatch
does not itself migrate or rewrite data.

- Confirm the intended connection and profile first.
- Check the live backend identity in Settings diagnostics, when available.
  Matching release-version labels do not establish build compatibility.
- “Backend reports 1” may be the UI's fallback when `build.contract` is absent
  or invalid. It does not necessarily mean the backend explicitly returned 1.
- Install both components from the same approved revision, then restart the
  process serving Desktop's API before reopening Desktop.
- A gateway restart reloads the API only if that gateway owns it. A separate
  `hermes serve` service can continue running old code after the gateway restarts.
  See [identify the API process](#identify-and-restart-the-api-process).

If the warning remains, collect the [support information](#what-to-include-in-a-support-report)
below instead of repeatedly reinstalling or resetting data.

## Check the repair before calling it complete

Use the same connection, profile, date range and filters as before the repair:

- The compatibility warning is gone, and the installed UI hash agrees with the
  approved source and the running backend's expected hash.
- The live backend reports the intended revision and a contract the UI supports.
  If identity fields are unavailable, record that verification is incomplete.
- Existing backend Usage history is present. Also check the Desktop-recorded
  history: it is a separate app-level ledger, not the backend usage database.
- Saved memberships, fees, budgets and settings are still present. Inspect them
  without changing or resaving them.
- Overview, Usage, Costs, Memberships, Reports, Model News and Settings open;
  returning between tabs produces no compatibility or backend-read errors.

An empty view is not proof of data loss. Recheck the connection, profile and
filters before taking further action. Totals can also change with date ranges
and pricing; compare the same scope. If a check fails, retain rollback files and
report which check failed. A cleared warning alone does not verify history.

## What to include in a support report

Include only the minimum needed to reproduce the problem:

- OS and Hermes version/build; local or remote backend; whether the API and
  gateway use separate services.
- Requested full commit SHA; installed Desktop SHA-256; live backend revision,
  contract and expected Desktop SHA-256, or which fields were missing.
- Exact warning text and whether it remained after restarting the identified API
  service and reopening Desktop.
- A short, redacted log excerpt around installation, reconciliation or restart,
  with timestamps and timezone.
- Which history, settings and navigation checks passed or failed.

Redact usernames, home paths, hostnames, IP addresses, process IDs, profile and
account identifiers, session content and financial figures. Never post tokens,
cookies, authorization headers, SSH keys, complete connection configuration,
databases, recovery exports or raw browser network archives. Review screenshots
and logs before sharing; service status and process command lines can contain
private details. Keep unredacted evidence locally.

## Advanced verification and repair

These steps are for someone comfortable inspecting files and processes. They
do not require a new profile or another environment. Replace every uppercase
placeholder before running a command, and run commands on the machine that owns
the component. Stop on permissions errors; ask the installation owner for help
rather than changing ownership, bypassing permissions or using elevated access
to force a file replacement.

### Verify the actual files and running build

Identify the loaded Desktop plugins root from Hermes' Desktop diagnostics/logs
and installation configuration. A common layout is
`<Desktop Hermes home>/desktop-plugins/spend-sense/plugin.js`, but custom homes,
packaged applications and linked development installs can differ. Do not hash
only a source checkout or the backend's copy and call it the installed UI.
The installed folder's `.hermes-package.json` marker, when present, can help
locate its package source. Read it locally; its pin and timestamp are metadata,
not proof of the installed bytes. Do not edit or delete it to force an update.

Hash the actual installed file using your platform's tool:

| Platform | Read-only command |
| --- | --- |
| macOS Terminal | `shasum -a 256 "/ABSOLUTE/DESKTOP/PLUGIN/PATH/plugin.js"` |
| Linux terminal | `sha256sum "/ABSOLUTE/DESKTOP/PLUGIN/PATH/plugin.js"` |
| Windows PowerShell | `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\ABSOLUTE\DESKTOP\PLUGIN\PATH\plugin.js'` |

Compare the hash values without regard to letter case. A Git commit SHA
identifies a repository revision; a SHA-256 identifies a file's contents.
They are different values and should not be compared directly. A header comment,
package card or version label is not a file identity check.

Use Settings diagnostics, or inspect the authenticated response to
`GET /api/plugins/spend-sense/health` through Hermes' developer tools, if available.
Keep the existing authentication gate; do not expose an unauthenticated endpoint
or copy authorization headers into a support report.

| Evidence | What to compare |
| --- | --- |
| `build.revision` from the live API | The approved full repository commit SHA |
| `build.desktop_sha256` from the live API | The SHA-256 of the actual installed Desktop file and the approved revision's `desktop/plugin.js` |
| `build.contract` from the live API | Must meet `REQUIRED_BACKEND_CONTRACT` in that Desktop source |
| Backend checkout revision | Disk evidence only; it does not prove the process reloaded it |

In builds with identity reporting, the backend captures these fields when its
API module is imported. Replacing files on disk does not refresh that process.
Missing identity fields are unknown evidence, not a successful pairing check.
Health's `ok` concerns store readiness; it does not establish release identity.

If the backend files need reinstalling, use the approved revision on the
backend machine, with the intended profile selected and a verified data backup
as described in the [quick start](quickstart.md#backup-upgrade-and-recovery):

```text
hermes plugins install https://github.com/WolfMark-Ltd/spendsense.git --force --ref FULL_40_CHARACTER_COMMIT_SHA
```

A pinned plugin may refuse `hermes plugins update spend-sense`. That refusal
protects its pin; it does not verify installed bytes or a running process.
After reinstalling, identify and restart the actual API owner below.

### Identify and restart the API process

Start with the connection selected in Desktop. For a direct connection, use its
API port. If that connection goes through a reverse proxy, inspect the proxy's
upstream configuration and identify the listener actually serving Hermes' API;
do not restart the proxy just because it owns the public port. On a remote
setup, inspect that upstream listener on its backend machine, not a local
tunnel's forwarding process. The upstream may use a different port or a Unix
socket; for a socket, inspect its process owner with the platform's socket or
service tools instead of the TCP commands below. Inspect output locally because
commands and service details may be private.

**Linux:** identify the listener and its owner:

```bash
ss -ltnp 'sport = :YOUR_API_PORT'
ps -p YOUR_PID -o pid,ppid,lstart,args
cat /proc/YOUR_PID/cgroup
```

A systemd cgroup can identify the owning unit. If it is a user service, run as
that service's OS user:

```bash
systemctl --user restart YOUR_IDENTIFIED_UNIT.service
systemctl --user is-active YOUR_IDENTIFIED_UNIT.service
```

If that shell reports “Failed to connect to bus: No medium found”, first confirm
the existing user bus socket exists:

```bash
test -S "/run/user/$(id -u)/bus"
```

Only if that succeeds, address that user's existing manager explicitly:

```bash
env XDG_RUNTIME_DIR="/run/user/$(id -u)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
    systemctl --user restart YOUR_IDENTIFIED_UNIT.service
env XDG_RUNTIME_DIR="/run/user/$(id -u)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
    systemctl --user is-active YOUR_IDENTIFIED_UNIT.service
```

Do not substitute another user's UID. For a system unit, container or other
supervisor, use that owner's documented restart procedure; user-systemd commands
do not apply. If process details are hidden, ask the service owner to identify
them.

**macOS:** `lsof -nP -iTCP:YOUR_API_PORT -sTCP:LISTEN` identifies a visible
listener. Inspect it with `ps -p YOUR_PID -o pid,ppid,lstart,args`. Use the
identified launchd job's or application's documented restart control. Do not
apply Linux systemd commands.

**Windows PowerShell:** `Get-NetTCPConnection -LocalPort YOUR_API_PORT -State Listen`
shows the owning process. Inspect its ID with `Get-Process -Id YOUR_PID`;
a service owner can map it using `Get-CimInstance Win32_Service | Where-Object
ProcessId -eq YOUR_PID | Select-Object Name, State`. Restart the identified
service through its normal management control. An app-managed process may not
be a Windows service.

If the identified owner is the Hermes gateway, use `hermes gateway restart`
for the correct profile. If it is a separate API service, restart that service.
Allow active work to finish using the service's supported procedure. Avoid
killing arbitrary processes or restarting unrelated services.

Confirm the actual API process has restarted and serves the new build identity,
then fully quit and reopen Desktop. “Service active” alone does not verify the
plugin's runtime identity.

### Replace only a proven stale Desktop file

Prefer the normal Hermes installation path. Use manual replacement only after
confirming all of the following:

- The exact loaded `plugin.js` is stale, and the approved Desktop revision is
  compatible with the backend you will run.
- No installation or reconciliation is in progress. Fully quit Desktop and any
  other app/server publishing that same Desktop plugins root.
- The repair is limited to one regular installed file. A linked checkout,
  differing assets or a changed package layout needs a complete supported
  installation, not this single-file procedure.
- You have an expected SHA-256 from reviewed release evidence and, where
  available, the matching live backend. Do not establish trust merely by hashing
  the same unverified download twice.

Save this Python 3 script outside the plugin directory as
`repair-desktop-plugin.py`. Edit the three placeholders. Keep the raw-string
prefix on `TARGET` so copied Windows backslashes remain literal; omit any
trailing directory separator because this path must end in `plugin.js`. It downloads
only `desktop/plugin.js` at the exact commit, verifies its hash before touching the
installation, creates and verifies an exclusive timestamped rollback copy, then
stages the replacement beside the target for an atomic rename.

Run it as your ordinary installation owner using `python3 repair-desktop-plugin.py`
on macOS/Linux or `py -3 repair-desktop-plugin.py` on Windows with Python 3 installed.
It deliberately refuses symbolic or redirected paths; ask for help with those
layouts. On failure, leave Desktop closed and retain any printed rollback copy.

```python
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile
from datetime import datetime, timezone
from urllib.request import urlopen
from uuid import uuid4

REVISION = "FULL_40_CHARACTER_COMMIT_SHA"
EXPECTED = "REVIEWED_64_CHARACTER_SHA256"
TARGET = Path(r"ABSOLUTE_PATH_TO_INSTALLED_PLUGIN_JS").expanduser()

def digest(data):
    return hashlib.sha256(data).hexdigest()

if not re.fullmatch(r"[0-9a-f]{40}", REVISION):
    raise SystemExit("Set the approved full commit SHA.")
if not re.fullmatch(r"[0-9a-fA-F]{64}", EXPECTED):
    raise SystemExit("Set the independently verified file SHA-256.")
EXPECTED = EXPECTED.lower()
if not TARGET.is_absolute() or TARGET.name != "plugin.js":
    raise SystemExit("Set the absolute installed plugin.js path.")
if TARGET.absolute() != TARGET.resolve() or not stat.S_ISREG(TARGET.lstat().st_mode):
    raise SystemExit("Target must be a regular file without redirected parents.")

url = (
    "https://raw.githubusercontent.com/WolfMark-Ltd/spendsense/"
    + REVISION + "/desktop/plugin.js"
)
with urlopen(url, timeout=30) as response:
    source = response.read()
if digest(source) != EXPECTED:
    raise SystemExit("Downloaded pinned source hash mismatch; no replacement.")
print("Pinned source verified:", EXPECTED)

original = TARGET.read_bytes()
original_hash = digest(original)
if original_hash == EXPECTED:
    raise SystemExit("Installed file already matches; no replacement needed.")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = TARGET.with_name(TARGET.name + ".rollback-" + stamp + "-" + uuid4().hex)
with backup.open("xb") as output:
    output.write(original)
    output.flush()
    os.fsync(output.fileno())
os.chmod(backup, stat.S_IMODE(TARGET.stat().st_mode))
if digest(backup.read_bytes()) != original_hash:
    raise SystemExit("Rollback verification failed; no replacement.")
print("Original installed SHA-256:", original_hash)
print("Verified rollback copy:", backup)

fd, stage_name = tempfile.mkstemp(prefix=".plugin.js-stage-", dir=TARGET.parent)
stage = Path(stage_name)
try:
    with os.fdopen(fd, "wb") as output:
        output.write(source)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(stage, stat.S_IMODE(TARGET.stat().st_mode))
    if digest(stage.read_bytes()) != EXPECTED:
        raise SystemExit("Staged hash mismatch; no replacement.")
    if digest(TARGET.read_bytes()) != original_hash:
        raise SystemExit("Installed file changed during repair; stop.")
    os.replace(stage, TARGET)
    if digest(TARGET.read_bytes()) != EXPECTED:
        raise SystemExit("Installed hash mismatch; retain rollback and seek help.")
finally:
    if stage.exists():
        stage.unlink()
print("Installed Desktop SHA-256 verified:", EXPECTED)
print("Restart the API owner if needed, then fully reopen Desktop.")
```

The rollback copy covers this JavaScript file only. It is not a backup of the
Desktop ledger or backend data. Keep it until the
[post-repair checks](#check-the-repair-before-calling-it-complete) pass.
If reopening Desktop replaces the repaired bytes again, stop and inspect the
package source and reconciliation evidence instead of repeatedly copying the file.

If rollback is necessary, close Desktop and all writers to this root again.
Verify the retained copy against the original hash, stage a copy beside the
target and replace only `plugin.js` by rename, then verify the restored hash.
Restore only a Desktop revision compatible with the running backend; ask for
support if that pairing is uncertain. Do not overwrite or delete usage databases,
app storage, memberships, settings or install metadata as part of this repair.
