# TrialPulse Teams app package

This directory contains everything needed to package and sideload the
TrialPulse Teams app: the app manifest, the declarative agent definition,
and the two icons.

```
teams/
  manifest/
    manifest.json        Teams app manifest (schema v1.17)
    color.png             192x192 full-colour icon
    outline.png            32x32 transparent outline icon
  declarative-agent/
    declarative-agent.json M365 Copilot declarative agent definition
    instructions.md        Source of truth for the agent's grounding/safety instructions
  scripts/
    generate_icons.py      Regenerates color.png / outline.png (python3 + Pillow)
  README.md               This file
```

## What this app registers with Teams

TrialPulse registers **two** separate integration surfaces, matching PRD
section 6.1:

1. **A personal tab** (`staticTabs` in `manifest.json`) — the full Ask /
   Browse / Dashboard experience in `packages/teams-tab`. All three views
   live inside one React app and switch via an in-app tab list; Teams only
   ever loads a single tab URL (`index.html`).
2. **A bot** (`bots` in `manifest.json`) — the conversational Q&A surface
   described in PRD section 5.2. Its messaging endpoint is the orchestrator
   (`packages/orchestrator`), which the Bot Framework Adapter routes every
   message through to the same `POST /api/query` used by the tab.
3. **A Microsoft 365 Copilot declarative agent** (`copilotAgents` in
   `manifest.json`, defined in `declarative-agent/declarative-agent.json`)
   — lets Meridian staff reach TrialPulse from Copilot directly. Its
   instructions (`declarative-agent/instructions.md`) enforce the same
   grounding/citation/refusal/RBAC rules as the bot and tab. **Read the
   "Known limitation" section at the bottom of `instructions.md` before
   enabling this broadly** — its document grounding comes from
   Microsoft Graph/SharePoint search (permission-based), not from the
   orchestrator's enforced `document_classification` `$filter`
   (`packages/shared/src/rbac.ts`). Those two access models must be kept in
   sync by Meridian's IT admin.

## Placeholders

Every `${{PLACEHOLDER}}` below must be substituted before packaging (either
by hand, or via Teams Toolkit / M365 Agents Toolkit environment variable
substitution, which replaces `${{NAME}}` tokens from a `.env` file across
every file in the package).

| Placeholder | Used in | Meaning |
|---|---|---|
| `${{VERSION}}` | manifest.json | Semantic version of this app package, e.g. `1.0.0`. Bump on every change that gets resubmitted/resideloaded. |
| `${{TEAMS_APP_ID}}` | manifest.json | A GUID you generate once per environment (dev/staging/prod) and never change afterward; it is the app's identity in Teams' app catalogue. `uuidgen` or `crypto.randomUUID()` works. |
| `${{TAB_ENDPOINT}}` | manifest.json | The base HTTPS URL the built `packages/teams-tab` app is deployed to, e.g. `https://trialpulse-tab.azurewebsites.net`. No trailing slash. |
| `${{TAB_DOMAIN}}` | manifest.json | Just the hostname portion of `TAB_ENDPOINT` (Teams' `validDomains` and the SSO `resource` URI both need the bare domain, not the full URL), e.g. `trialpulse-tab.azurewebsites.net`. |
| `${{BOT_APP_ID}}` | manifest.json | The **Microsoft App ID** of the Azure Bot resource / Bot Framework registration that fronts the orchestrator's bot endpoint. This is a separate Entra app registration from the SSO app below (Bot Framework requires its own app registration), created when you provision the Azure Bot resource. |
| `${{AAD_APP_CLIENT_ID}}` | manifest.json | The **Application (client) ID** of the Entra app registration used for Teams SSO (`webApplicationInfo`). This is the app whose **App roles** blade defines the six TrialPulse roles in PRD section 3.1 (`regulatory_affairs`, `clinical_operations`, `medical_affairs`, `site_monitor`, `executive`, `it_admin`) — see "Entra app registration mapping" below. |
| `${{SHAREPOINT_PROTOCOLS_LIBRARY_URL}}` etc. (6 total) | declarative-agent.json | The absolute SharePoint URL of each document library in PRD section 2.2 (`Protocols/`, `Investigator Brochures/`, `Regulatory Submissions/`, `Safety Reports/`, `Site Communications/`, `Competitive Intelligence/`), so the declarative agent's `OneDriveAndSharePoint` capability only ever searches those libraries. |

## Entra app registration mapping

`webApplicationInfo` in `manifest.json` wires Teams SSO to a single Entra
app registration:

- `webApplicationInfo.id` = that app's **Application (client) ID**
  (`${{AAD_APP_CLIENT_ID}}`).
- `webApplicationInfo.resource` = `api://${{TAB_DOMAIN}}/${{AAD_APP_CLIENT_ID}}`
  — the bare **Application ID URI**, exactly as configured under "Expose an
  API" on that same app registration. **Do not append `/access_as_user` or
  any other scope name to this value.** A Teams SSO token's `aud` claim is
  always the app registration's Application ID URI itself, never a scope
  URI, so appending the scope name here makes every token TrialPulse issues
  fail audience validation (every tab/bot request 401s, forever, no matter
  how many times the client retries). The scope is configured *separately*,
  underneath the same Application ID URI on that blade: add a custom scope
  named `access_as_user` (the standard Teams SSO scope name; its own full
  URI, `api://${{TAB_DOMAIN}}/${{AAD_APP_CLIENT_ID}}/access_as_user`, is
  what Teams requests consent for — it is not what goes in `resource`).
  Grant the Teams client IDs (`1fec8e78-bce4-4aaf-ab1b-5451cc387264` for
  desktop/mobile, `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` for web) as
  pre-authorized applications for that scope, per standard Teams SSO setup.
  **This Application ID URI, `webApplicationInfo.resource` above, and
  `entraApiAudience` in `infra/main.parameters.dev.json` /
  `infra/main.parameters.prod.json` (which flows to `ENTRA_AUDIENCE`, the
  value the orchestrator's `jwtVerify(..., { audience })` enforces on every
  request — see `infra/README.md` "Entra identity: one value, three
  places") are ONE value in THREE places.** Nothing mechanically keeps them
  in sync; whoever changes one of the three must update the other two in
  the same change, or every tab and bot request 401s.
- The six roles in PRD section 3.1 are defined under **App roles** on this
  same registration (`appRoles` in its manifest, each with
  `allowedMemberTypes: ["User"]`), and assigned to users/groups via
  **Enterprise applications → TrialPulse → Users and groups** in the Azure
  portal, or via Microsoft Graph (`appRoleAssignments`). The orchestrator
  reads the `roles` claim off the validated JWT on every request
  (`packages/orchestrator`) — there is no separate role database. A user
  with no assigned role is treated as `site_monitor` (see
  `DEFAULT_ROLE` / `resolveRole` in `packages/shared/src/rbac.ts`).
- `${{BOT_APP_ID}}` is a **different** app registration (or an
  Azure Bot resource, which provisions one for you) used purely for Bot
  Framework channel authentication. It does not need App roles configured;
  the bot's messaging endpoint calls the same orchestrator, which validates
  the *user's* SSO token (obtained via Teams' bot SSO flow), not the bot's
  own identity, for role enforcement.

## Packaging

Teams app packages are a flat zip: `manifest.json` and every file it
references (`color.png`, `outline.png`, `declarativeAgent.json`) must sit at
the zip root, not in subfolders. This repo keeps them in `manifest/` and
`declarative-agent/` for clarity, so packaging is a two-step process:

```bash
# 1. Generate the icons (only needed once, or after editing generate_icons.py)
python3 teams/scripts/generate_icons.py

# 2. Stage a flat directory and zip it
rm -rf /tmp/trialpulse-package && mkdir -p /tmp/trialpulse-package
cp teams/manifest/manifest.json /tmp/trialpulse-package/
cp teams/manifest/color.png teams/manifest/outline.png /tmp/trialpulse-package/
cp teams/declarative-agent/declarative-agent.json /tmp/trialpulse-package/declarativeAgent.json
cp teams/declarative-agent/instructions.md /tmp/trialpulse-package/instructions.md
# Substitute every ${{PLACEHOLDER}} in manifest.json/declarativeAgent.json for
# your environment before zipping (see the placeholder table above).
# Inline instructions.md into declarativeAgent.json's "instructions" field --
# the $[file('instructions.md')] token is a Microsoft 365 Agents Toolkit
# convention; if your pipeline doesn't resolve it automatically, paste
# instructions.md's contents into that field by hand and drop the separate file.
cd /tmp/trialpulse-package && zip -r ../trialpulse.zip .
```

If you provision with the **Microsoft 365 Agents Toolkit** (formerly Teams
Toolkit) instead, point its `teamsapp.yml`/`aad.manifest.json` provisioning
steps at this `teams/` directory; it performs the placeholder substitution,
`$[file(...)]` inlining, and flat-zip packaging automatically.

## Sideloading

1. Complete the placeholder substitution above and deploy
   `packages/teams-tab`'s production build (`npm run build -w
   @trialpulse/teams-tab`, output in `packages/teams-tab/dist/`) to
   `${{TAB_ENDPOINT}}`.
2. Zip the package as shown above (`trialpulse.zip`).
3. In Teams: **Apps** → **Manage your apps** → **Upload an app** → **Upload
   a custom app**, and select `trialpulse.zip`. (This option must be
   enabled for your tenant/user under Teams Admin Center → Teams apps →
   Setup policies → "Upload custom apps".)
4. Open the app. On first launch, Teams will prompt for consent to the
   `access_as_user` scope (Teams SSO) — accept it. If your account has no
   TrialPulse app role assigned yet, you'll see the Site Monitor
   (most-restricted) view with a banner explaining why; ask your IT admin to
   assign a role in Entra ID.
5. To update after changes: bump `${{VERSION}}` in `manifest.json`, rebuild
   the zip, and re-upload via the same flow (Teams treats a re-upload of a
   higher version as an update, not a new install).
