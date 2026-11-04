# Gemini configuration and model discovery

Implemented alongside Print Tools **1.17.0**. The client is staged to `C:\PrintToolsNative` with its version and file hashes verified. API build/tests pass; **server deployment is not verified** and no live Google requests or charges were made during development.

## Prepared-size visual review (Print Tools 1.19.0)

New authenticated **POST `/reports/inspect`**, separate from order parsing. Build and all 41 tests pass. Client 1.19.0 is staged to `C:\PrintToolsNative` with Corel closed; staged version, all 13 managed files, native host and dependencies/licenses were verified. Deploy this API revision after pushing; deployment of the new route is not verified. The operator confirmed the earlier 1.17 Gemini API is published; this does not deploy the new review route. No new dependencies or database migration.

The report's **Capture / recapture sizes** is local only. **Send captured parts to Gemini…** reads the configured model and requires explicit consent with request/image counts and a data/charge disclosure. It sends one request per named part from a representative actual personalized formation per product/artwork/size, with an overview, up to four overlapping detail quadrants and optional base-part comparison. All distinct formations are included; other copies are not visually certified. Crop edges are artificial, normalization is display-only and base context is not approved truth.

Request: `{modelId, inspectionKey, product, artwork, size, part, rowIndex, expected:{name,number,size}, images:[{id,kind,data,sha256,rotation}]}`. `kind` is `actual`, `detail` or `reference`; exactly one actual image and at most one optional reference, at most six total. Only PNG/base64 with matching SHA-256 and bounded IHDR dimensions are forwarded: 4 MiB/image, 12 MiB total decoded bytes, dimensions 1–4096 each. This stays below Google's documented 20 MB inline request budget, including base64 overhead/context. Input headers/hashes are checked, not decoded by a new server image library; Google must still accept the PNG itself. The selected model must match the stored, tested configuration; unavailable/unvalidated/mismatched settings fail without a Google generation request. No fallback.

Response: `{inspectionKey,modelId,promptVersion:"size-parts-v1",coverage,findings:[{category,imageId,observed,explanation,confidence}]}`. Categories: `damaged_or_clipped`, `unusual_logo`, `possible_missing_logo`, `possible_extra_logo`, `possible_text_issue`, `uncertain`. Confidence: `low|medium|high`, self-assessed, not calibrated. Findings must refer to supplied actual/detail images, not an invented ID or reference alone. All fields/counts/lengths are validated; blocked/truncated/malformed results fail, never turn into a pass. No model-provided Corel IDs/commands, boxes, invented authoritative counts or automatic edits. No findings means nothing suspicious reported in the supplied images—not print approval.

Server-owned instructions treat artwork/labels as untrusted data, preserve expected names/accents/leading zeros and ask about cut-off/damaged logos, internal artwork rotation, suspicious duplication and visually odd text. They allow normal size proportions and nesting rotation, distinguish crop edges/intentional bleed, and require uncertainty for unreadable areas. Gemini is a second pair of eyes, not a spelling authority or reliable guarantee of catching a deliberately bad logo.

Queue is client-owned and sequential. Cancel/close stops unsent jobs; a submitted request may still be charged. A service error stops the remaining queue; retry is explicit and excludes completed jobs. Image hashes and result model/key/prompt identity are checked client-side. Recapture explicitly replaces snapshots/results after artwork changes. No image/result database or payload logging is added. Client temporary PNGs are removed on report disposal; crash/lock leftovers may contain sensitive player/design data.

Google timeout is 90 seconds/review; client is 120 seconds. Allow reverse-proxy timeout and body limits accordingly (existing Express limit is 50 MB). Order parsing retains its prior 60-second Google timeout. Tests use fake Google responses—no real key, upload or paid call. All **41 API tests** pass, including auth/config mismatch, PNG/hash validation, exact `007`/Unicode context, prompt/schema construction and rejection of invented evidence/truncation. Live Corel PNG fidelity, model schema compatibility/quality and actual billing still need explicit acceptance after rollout. See the plugin README 1.19.0 for the deliberate XS cut-off logo and internally rotated artwork fixtures.

References: [image understanding / inline limits](https://ai.google.dev/gemini-api/docs/image-understanding), [structured output](https://ai.google.dev/gemini-api/docs/structured-output).

## Deployment and setup

1. Deploy the updated `api/` through the existing Coolify workflow. No dependency or schema migration is required; the existing `app_settings` table stores the configuration and validation marker.
2. Publish/stage Print Tools 1.17.0 only with authorization and Corel closed. Updating the DLL does **not** deploy the API.
3. In Settings, enter a Gemini Developer API key and click **Save Gemini key**. Enable billing on its Google project for paid API usage. A Gemini consumer subscription does not configure this API project.
4. **Refresh models**, select a model, then **Test & save**. Confirm the charge warning. A small 64×64 image plus structured JSON generation request must succeed before the model is saved and AI parsing is enabled.
5. Smoke-test a real screenshot and text order, including jersey number `007`. CSV/TSV import and manual jersey generation do not require Gemini.

Discovery and key verification make metadata requests only. Testing and Parse with AI make generation requests and may incur charges. The model list has no prices; manage billing/quota in Google AI Studio/Cloud Billing. The compatibility test checks accepted image input and structured JSON, **not OCR accuracy on real orders**. No automatic retries or model fallback are used. Google may retarget a `latest`/preview alias without changing its ID; select an explicit version when reproducibility matters.

Allow sufficient reverse-proxy request timeouts for testing/parsing (client 90 seconds; Google generation timeout 60 seconds, plus discovery up to 20 seconds). Local tests ran on Node 24, not in Coolify's Node 20 Alpine image. The installed `pdf-parse` 2.x requires Node >=20.16.0 in the Node 20 line; verify the deployed image and PDF smoke test.

## Authenticated endpoints

All endpoints retain the existing `X-Api-Key` authentication. The Gemini key is stored on the server, sent to Google only in `x-goog-api-key`, and never returned to the plugin.

| Method | Path | Action |
|---|---|---|
| GET | `/settings/ai` | `{keyConfigured, modelId, ready, migrationRequired}`; no secret |
| GET | `/settings/ai/models` | Paginated Google discovery, returned as `{id,displayName,description}[]` |
| PUT | `/settings/ai/key` | `{key}`; verify discovery access, then atomically save Gemini key/provider and clear model validation |
| PUT | `/settings/ai/model` | `{modelId}`; **billable compatibility test**, then save model/validation atomically |
| POST | `/orders/parse` | Use the saved, tested Gemini model; text/image order parsing |
| POST | `/reports/inspect` | New in 1.19.0; explicitly authorized advisory garment-part image review, deployment pending |

Legacy `PUT /settings/ai_*` writes are rejected so older clients cannot bypass key/model validation. Existing non-Gemini credentials are **not** sent to Google or relabelled as Gemini; the operator must explicitly save a Gemini key. Switching from another provider clears its old model. Rotating a Gemini key preserves the selected model ID but requires a fresh Test & save. Existing Gemini selections also require testing once because older configurations have no validation marker. A failed test leaves the previous model unchanged; a key changed during testing prevents saving a validation against the wrong key.

Discovery filters for `models/gemini-*` with `generateContent` support and excludes known audio/TTS/live/image-generation/embedding/specialized names. It follows all pages with bounded pagination/timeouts. Google's model metadata lacks complete modality flags, so filtering is provisional; the explicit image/JSON test is mandatory. New generation families need no hard-coded version list. Saved IDs are never silently replaced, and the plugin visibly marks unavailable selections.

Parsing uses Gemini's structured JSON schema and validates the entire response before returning any rows; blocked/truncated/malformed responses fail rather than importing partial orders. String numbers preserve leading zeros. `/orders/parse` returns exact `numberText` for updated clients and retains the legacy integer/null `number` field for older clients. Old clients still cannot preserve leading zeros without updating. Artwork/Product AI suggestions remain deferred. Text PDFs use the already-installed `pdf-parse` 2.x API; PDFs without extractable text still require PNG/JPG conversion rather than new OCR functionality.

## Checks

```sh
cd api
npm run build
npm test
```

The Gemini tests mock Google fetches and the settings table while executing the real authenticated Express routes. They cover pagination/filtering, future IDs, key secrecy, safe provider migration, explicit testing, failed-test preservation, concurrent key changes, JSON validation, leading-zero compatibility and text/blank PDFs. They do not establish real key permissions, billing, quotas, model OCR quality, PostgreSQL locking under load or deployment correctness.

References: [models.list](https://ai.google.dev/api/models), [structured output](https://ai.google.dev/gemini-api/docs/structured-output), [billing](https://ai.google.dev/gemini-api/docs/billing).
