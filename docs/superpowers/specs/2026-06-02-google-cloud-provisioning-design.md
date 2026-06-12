# Google Cloud provisioning + sourcing upgrades — design

**Date:** 2026-06-02
**Status:** approved (verbal) — sub-project A first
**Repo:** china-content-bank (multi-parser producer)

## Problem

1. Durable storage on Google Drive is **not active**: `storage.ts` has a working
   service-account (SA) backend, but secrets `GDRIVE_SA_JSON` / `GDRIVE_FOLDER_ID`
   are empty → banked MP4s live only in CI artifacts (14d).
2. We want a single clean Google Cloud project that also yields **YouTube Data**
   and **Custom Search** keys for discovery/grounding.
3. The existing Gemini key sits on a billing-suspended project (limit:0). NOT
   addressed here — prod uses NIM primary; we do not mint a new Gemini key in A.

## Decomposition (independent sub-projects, in order)

- **A. Google Cloud provisioning** — unblocks storage + search keys. *This doc.*
- **B. VPN hardening** — improve the mihomo/clash proxy in `banker.yml` to raise
  yt-dlp success rate.
- **C. Reddit discovery + search grounding** — improve scout's Reddit feed; wire
  Custom Search (incl. creating the Programmable Search Engine `cx`) as grounding
  for the Groq/NVIDIA path (no built-in google_search).
- **D. Scraper improvements** — broadest; its own brainstorm.

B/C/D each get their own spec → plan → implementation cycle later.

## Sub-project A — design

### Decisions
- **Tooling:** `gcloud` CLI (reliable, scriptable). Automating Google login via
  Playwright is bot-detected and fragile — rejected. Browser is needed only for
  the Programmable Search Engine `cx`, which is **deferred to C**. → A is 100%
  gcloud, **zero browser steps**.
- **Old projects:** delete all, create one fresh project. Destructive but
  recoverable for 30 days. The full `gcloud projects list` is shown to the user
  for confirmation **before** any deletion.
- **No billing link:** Drive / YouTube Data / Custom Search all run on free quota
  without a billing account → sidesteps the account's billing suspension entirely.
- **APIs enabled:** `drive`, `youtube` (Data API v3), `customsearch`, plus
  `apikeys` (needed to mint API keys).
- **Drive storage = service account (keep current code).** Trade-off noted: a SA
  cannot use the user's personal 5TB quota (SA-owned files cap at ~15GB). For a
  transient buffer of 8–44MB clips that consumers pull and delete, ~15GB rolling
  is enough and requires no code change. If a long-term 5TB archive is wanted
  later, switch to OAuth user credentials (separate task).
- **No manual Drive sharing:** the SA creates its own folder via the Drive API;
  that folder id becomes `GDRIVE_FOLDER_ID`. Consumers read with the same SA creds.
- **Secrets:** set via `gh secret set` (gh already authed). Local `.env` is the
  user's to edit (project rule: Claude never edits `.env`).

### Runbook
0. Install gcloud (winget); user runs `! gcloud auth login` (the only manual step).
1. `gcloud projects list` → show user, get confirmation.
2. For each project: `gcloud projects delete <ID> --quiet`.
3. `gcloud projects create china-bank-<suffix>` (no billing) + set as default.
4. `gcloud services enable drive.googleapis.com youtube.googleapis.com customsearch.googleapis.com apikeys.googleapis.com`.
5. SA `china-bank-storage` + `gcloud iam service-accounts keys create sa.json` → `GDRIVE_SA_JSON`.
6. `gcloud services api-keys create` ×2, restricted to youtube / customsearch → `YOUTUBE_API_KEY`, `SEARCH_API_KEY`.
7. Node smoke script (uses sa.json): create Drive folder `china-content-bank`,
   print id → `GDRIVE_FOLDER_ID`; upload + delete a test file to prove write.
8. `gh secret set`: `GDRIVE_SA_JSON` (base64), `GDRIVE_FOLDER_ID`, `YOUTUBE_API_KEY`,
   `SEARCH_API_KEY`. (CSE `cx` deferred to C.)
9. Verify: YouTube key returns a search hit; secrets present via `gh secret list`.

### Out of scope for A
- Programmable Search Engine `cx` creation (→ C).
- Wiring Custom Search into the scout (→ C).
- Any new Gemini key.
- OAuth-user Drive backend / 5TB archive.

## Verification
- `sa.json` write+delete round-trips against the SA Drive folder.
- `YOUTUBE_API_KEY` returns ≥1 result for a sample `search.list`.
- `gh secret list` shows all four secrets in the repo.
- Local egress not required (gcloud is not geo-blocked like Gemini).

## Risks
- Project deletion is irreversible after 30 days → gated on explicit user confirm
  of the printed list.
- SA ~15GB cap → acceptable for transient buffer; documented escape hatch (OAuth).
- winget gcloud install may need elevation → fall back to per-user installer.
