# SpendSense quick start

Get from zero to your first usage reading in about fifteen minutes. This guide covers installing SpendSense from Hermes Desktop, confirming it works, reading your first figures, and keeping your data safe.

SpendSense is early-access software. Back up your Hermes profile data before installing or upgrading, and report problems as [GitHub issues](https://github.com/WolfMark-Ltd/spendsense/issues/new/choose).

## Before you install

| Requirement | Detail |
| --- | --- |
| Hermes | `>= 0.22.5`, per the plugin manifest. Newer builds are not yet verified. |
| Profile | An isolated Hermes profile for evaluation. |
| Backup | A backup of your Hermes profile data (see [Back up](#backup-upgrade-and-recovery)). |

SpendSense is local-first: each Hermes install records only the usage it sees, and there is no sync between machines. Install it on each machine you want accounted.

macOS and Windows users follow the same Desktop steps below. The automated test suites run on Linux and Windows, and the file locking supports both — but the Desktop install flow itself is still being verified on each platform, so treat exact dialog wording as indicative.

## Install from Hermes Desktop

This is the recommended route. One install places both halves: the agent backend (hooks, ledger, API) into the connected backend, and the SpendSense UI into the app's local `desktop-plugins` folder.

1. Open Hermes Desktop and connect to the backend you want to measure.
2. Open plugin installation and enter this repository URL: `https://github.com/WolfMark-Ltd/spendsense`
3. Leave the commit pin empty for the latest code, or pin a validated SHA for a known-good install.
4. Choose the profile to install for, then Install.

For servers and headless setups, the [README](../README.md#from-the-command-line) has command-line instructions. If your Desktop app runs on another machine than the backend, complete the install from inside the app: the Desktop UI loads from the app's own local folder.

### The unverified-source warning

Until SpendSense is admitted to the Hermes catalogue, the install dialog warns that the source is unverified. This is expected. Before proceeding, check the repository URL matches exactly:

`https://github.com/WolfMark-Ltd/spendsense`

Do not proceed if the URL differs.

## Confirm both halves installed

SpendSense has two components, and the install is only complete when both are in place:

- **Desktop UI half** — a **SpendSense** entry appears in the sidebar, with a status-bar chip and a side pane. Opening the entry loads the full page.
- **Agent backend half** — the page can read backend usage. Open SpendSense and check the Overview: if it shows backend figures (or an honest empty state such as "No backend calls recorded in the last 30 days"), the backend half is active on this profile.

If you see **"The SpendSense backend is not reachable"** or **"Backend usage could not be read for this connection"**, the UI half is working but the backend half is not active on the connected profile. See [If something goes wrong](#if-something-goes-wrong).

Note: the dashboard web view intentionally shows only "Open SpendSense in Hermes Desktop to view your usage." The full interface is the Desktop plugin.

## Open SpendSense and find your way

Open the **SpendSense** sidebar entry. The page has seven tabs:

| Tab | What it answers |
| --- | --- |
| Overview | What did I use, what is it worth, what fees did I save, what needs attention? |
| Usage | Which models and routes drove tokens and cost? |
| Costs | Fees, allowances, wallets and custom rules in one place. |
| Memberships | Which plan is each provider account on? |
| Reports | A local 7- or 30-day Markdown digest. |
| Model News | New models and price changes detected locally. |
| Settings | Privacy controls, data recovery export, and About. |

The sixty-second tour: **Overview** for the headline figures, **Usage** for the model × route breakdown, **Memberships** to confirm your plans, and **Settings** when you need the recovery export.

## Connect to the right profile

Backend analytics come from the profile the agent component is active on. If your figures look empty or stale:

- Make sure Desktop is connected to the same profile you installed for.
- Switching gateway or profile discards the previous scope, so readings always belong to the current connection — never a mix.
- Each profile keeps its own ledger, memberships and billing rules. There is no cross-profile view.

The Desktop ledger is kept per profile even though it lives in one app-level store, so your laptop and server never merge figures.

## Read your first figures

Open **Overview**. It shows four headline figures that answer different questions:

| Figure | What it tells you |
| --- | --- |
| Recorded usage · API-equivalent, this month | Desktop-recorded tokens priced at capture. |
| API-equivalent estimate · backend, 30 days | Timestamped backend calls priced at current catalogue rates. |
| Actual provider charges · 30 days | What the provider billed. Currently **Not recorded** (see below). |
| Saved account fees · by currency and billing period | Fees you declared on your memberships. |

Two honest expectations for a first run:

- **The two API-equivalent figures will differ.** The Desktop ledger settles each call at the rate available when it was recorded; backend analytics re-price timestamped calls at today's catalogue. They are related views, not one figure.
- **Actual provider charges says "Not recorded".** The current analytics endpoint carries no per-call actual-charge evidence, so SpendSense refuses to guess. This is deliberate, not a fault.

Then visit **Memberships** and confirm which plan each discovered account is on. Discovery only proves an account is configured — it cannot prove the plan — so your confirmation is what makes every later comparison trustworthy. Model News shows nothing until its second snapshot: the first is a baseline.

## Three money figures, never one total

New users trip on one idea, so here it is plainly:

- **API-equivalent cost** is a comparison price: what the same tokens would cost at published pay-as-you-go rates. It judges whether a plan is worth keeping. It is not money you spent.
- **Subscription fees** are the plan fees you declared. They are real money leaving your account, on their own billing period and currency.
- **Actual provider charges** are what the provider really billed. SpendSense does not have this evidence today, so it says **Not recorded** instead of presenting the API-equivalent figure as a bill.

These are never added together. A membership card also keeps provider-reported usage (quota Hermes read from the provider) apart from metered cost (allowance consumed under your rules). The [README](../README.md#four-figures-never-summed) has the full table.

## When a value says Unknown, Partial or Not recorded

SpendSense never shows unknown as zero. Each label is an instruction:

| Label | Meaning | What to do |
| --- | --- | --- |
| Unknown | No evidence yet. | Use Hermes normally, then recheck. For fees, confirm the plan or add a fee override in Memberships. |
| Partial (≈, lower bound) | A priced subtotal; some usage could not be priced. | Treat it as a minimum. Check Usage for the unpriced share and its reason (no rate, no cache evidence, tiered pricing). |
| Not recorded | The hook evidence does not exist. | For actual charges, nothing to fix — the endpoint carries no charge evidence. For backend usage, check you are on the installed profile. |

A dash means unknown or unavailable, never zero. Zeros appear only where recording genuinely observed nothing.

## If something goes wrong

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Unverified-source warning | Expected until catalogue admission. | Verify the repository URL matches exactly, then proceed. |
| No sidebar entry after install | The UI half did not land. | Install from inside the Desktop app, especially if it runs on another machine than the backend. |
| "The SpendSense backend is not reachable" | The backend half is not active on this connection. | Connect to the profile you installed for and confirm the agent component is enabled there. |
| "Backend usage could not be read" / "unavailable" | Same as above, or an empty store. | Check the profile first; a fresh install honestly reports no calls. |
| Discovery finds nothing | No credential slots in this profile's Hermes auth storage. | Add the provider account in Hermes, then run discovery again. |
| Membership edits conflict or report uncertain writes | Stale revision after a concurrent change. | Reload membership data before retrying; nothing was overwritten. |
| Store unreadable errors | A damaged local JSON store. | Stop the plugin and restore from backup; never let a tool overwrite the damaged file. |

For anything else, open a [GitHub issue](https://github.com/WolfMark-Ltd/spendsense/issues/new/choose) with the Hermes version, the profile setup, and the exact message shown.

## Backup, upgrade and recovery

All SpendSense data lives under the profile's plugin-data directory (`<hermes home>/plugin-data/spend-sense/`). Back it up **with the plugin stopped**, and restore files together to the same profile — if a file was absent when the backup was taken, it should also be absent after restoration.

| File | Contents | Back up? |
| --- | --- | --- |
| `usage.db` | Recorded per-call ledger (180-day retention). | Yes |
| `memberships.json` | Plans, fee overrides, exhaustion marks. | Yes |
| `membership-seats.json` | Seat quantity history. | Yes |
| `membership-entitlements.json` | Route-to-account entitlement relationships. | Yes |
| `billing-profiles.json` | Advanced billing rules. | Yes |
| `budgets.json` | Budget guardrails and dismissals. | Yes |
| `fx-rates.json` | Dated FX rates you supplied. | Yes |
| `news-*.json`, `plans-feed-cache.json`, `monitoring-state.json` | Regenerable caches and settings. | Optional |

Two more safety nets:

- **Settings recovery export.** Settings can copy a JSON bundle to the clipboard: `membership_store` restores as `memberships.json`, `seat_history` as `membership-seats.json`, `route_entitlements` as `membership-entitlements.json`, `advanced_rules` as `billing-profiles.json`, and `budget_guardrails` as `budgets.json`. It contains no credentials and no usage ledger. Retain it securely.
- **Settings reset.** Reset clears memberships, route entitlements, budgets and advanced rules for the current profile. Captured usage records, Hermes data, provider credentials and catalogues are left untouched.

When upgrading: back up first, keep the existing `spend-sense` plugin ID and `/spend-sense` route (changing them orphans stored data), and never install over an existing plugin without a verified backup. Releases older than 0.6.0 may not recognise newer membership fields, so keep the pre-upgrade backup until the new version is confirmed working.

## Next steps

- [README](../README.md) — features, how recording and pricing work, privacy.
- [Release checklist](../RELEASING.md) — what remains before formal release.
- [Model News feed contract](../news-feed/README.md) and [plans feed contract](../plans-feed/README.md) — Live Updates disclosures.
