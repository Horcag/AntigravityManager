# Proxy Gateway Server Module Guide

---

## 1. Overview & Scope

The `server` directory contains the core backend implementation of the Proxy Gateway module in AntigravityManager, built on the NestJS framework.

### Core Responsibilities
1. **Multi-Protocol LLM Gateway Translation**: Unified handling and orchestration of OpenAI (Chat, Completions, Responses, Media), Anthropic (Messages API), and Gemini (Native Generate/Stream) protocol requests.
2. **Account Lease & Scheduling Management**: Coordination of account loading, candidate selection, rate limiting, quota tracking, sticky sessions, and parity scheduling.
3. **Resilience & High Availability**: Cross-protocol retry backoff, circuit breaking, explicit model routing, rate-limit tracking, and same-model account failover.
4. **Streaming & WebSocket Transport**: Native support for Server-Sent Events (SSE) and real-time bidirectional OpenAI Responses WebSockets.

---

## 2. Directory Structure

The `server` directory follows a modular NestJS structure, separating feature capabilities into dedicated sub-modules:

```plaintext
server/
├─ README.md                               # Module documentation
├─ proxy.module.ts                         # Root composite module (Proxy Gateway entry point)
├─ proxy.service.ts                        # Facade service (delegates requests to specific protocol services)
├─ common/                                 # Shared abstractions and common boundaries
│  ├─ base-proxy.controller.ts             # Base controller for protocol handlers (SSE, error responses, logging)
│  ├─ base-proxy.service.ts                # Base service for protocol handlers (Request ID, stream timers, error classification)
│  ├─ interfaces/                          # Cross-protocol request, response, and intermediate types
│  │  └─ request-interfaces.ts
│  ├─ exceptions/                          # Unified exception types for upstream request errors
│  │  └─ upstream-request.exception.ts
│  └─ utils/                               # Protocol-agnostic utility functions (e.g., User-Agent parsing)
│     └─ request-user-agent.ts
├─ guards/                                 # Access control and credential parsing
│  ├─ proxy.guard.ts                       # Proxy credential and OpenCode scope validation
│  ├─ admin.guard.ts                       # Admin endpoint permission validation
│  └─ api-key-auth.util.ts                 # API key extraction and normalization utilities
├─ modules/                                # Sub-modules organized by feature capability
│  ├─ openai/                              # OpenAI protocol sub-module
│  │  ├─ openai.controller.ts              # Chat, Completions, Responses, Image, and Audio endpoints
│  │  ├─ openai.service.ts                 # Request orchestration, stream conversion, tool call mapping
│  │  ├─ openai.module.ts                  # NestJS OpenAI module registration
│  │  ├─ responses/                        # OpenAI Responses WebSocket protocol and session store
│  │  │  ├─ openai-responses-session.store.ts
│  │  │  ├─ openai-responses-websocket.protocol.ts
│  │  │  └─ openai-responses-websocket.server.ts
│  │  └─ media/                            # Image and audio multipart input parsing & monitoring summary
│  │     ├─ image-multipart-request.ts
│  │     └─ image-monitoring-summary.ts
│  ├─ anthropic/                           # Anthropic protocol sub-module
│  │  ├─ anthropic.controller.ts           # Messages API route handler
│  │  ├─ anthropic.service.ts              # Request orchestration, stream conversion, session key extraction
│  │  └─ anthropic.module.ts               # NestJS Anthropic module registration
│  ├─ gemini/                              # Gemini native protocol sub-module
│  │  ├─ gemini.controller.ts              # Model listing, content generation, and token counting endpoints
│  │  ├─ gemini.service.ts                 # Gemini request orchestration and SSE passthrough
│  │  ├─ gemini-client.service.ts          # Upstream HTTP client, endpoint failover, explicit context cache
│  │  ├─ explicit-context-cache.store.ts   # Explicit context cache storage
│  │  └─ gemini.module.ts                  # NestJS Gemini module registration
│  ├─ files/                               # Local content-addressed file store & the three file surfaces
│  │  ├─ file-content-store.service.ts     # The store's policy: put/get/stat/list/delete/sweep
│  │  ├─ file-store-disk.ts                # Every path, atomic rename and index parse
│  │  ├─ file-store.types.ts               # Handles, limits, errors, handle parsing
│  │  ├─ file-mime-sniff.ts                # Magic-byte MIME sniffing
│  │  ├─ file-upload-request.ts            # Multipart & raw-media upload parsing
│  │  ├─ file-reference-expander.ts        # The single handle -> inline content routine
│  │  ├─ gemini-files.controller.ts        # /upload/v1beta/files and /v1beta/files
│  │  ├─ client-files.controller.ts        # /v1/files for both the OpenAI and Anthropic dialects
│  │  └─ {gemini,openai,anthropic}-file-resource.ts  # Per-dialect shapes, errors and upload rules
│  └─ account-lease/                       # Account lease and scheduling sub-module
│     ├─ account-lease.service.ts          # Main Account Lease facade service
│     ├─ account-lease.module.ts           # Account Lease module assembly
│     ├─ interfaces/                       # Type definitions, token states, and adapter ports
│     │  ├─ account-lease-token-types.ts
│     │  └─ account-lease-adapters.ts
│     ├─ stores/                           # Token loading, transformation, and in-memory cache
│     │  └─ account-lease-token.store.ts
│     └─ policies/                         # Pure strategy policy implementations
│        ├─ account-lease-config.policy.ts       # Configuration & scheduling mode policy
│        ├─ account-lease-selection.policy.ts    # Candidate filtering, sticky sessions & round-robin
│        ├─ account-lease-quota.policy.ts        # Quota snapshot & recovery calculation
│        ├─ account-lease-quota-refresh.policy.ts# Real-time quota refresh & lockout coordination
│        ├─ account-lease-hydration.policy.ts    # OAuth refresh & account hydration
│        ├─ account-lease-fulfillment.policy.ts  # Token final state confirmation & fulfillment
│        ├─ account-lease-limit.policy.ts        # Cooldowns, model rate limits & error tagging
│        └─ account-lease-model.policy.ts        # Model capability, fallback & output budget policy
└─ shared/                                 # Cross-module shared services (singleton dependencies)
   └─ services/
      ├─ proxy-retry.service.ts            # Retry backoff and token re-selection strategy
      ├─ rate-limit-tracker.service.ts     # Google & generic rate-limit tracking service
      ├─ model-routing.service.ts          # Model identifier normalization & target routing
      ├─ model-availability.service.ts     # Account model capability & availability persistence
      ├─ generation-constraints.service.ts # Output caps and thinking budget constraints
      └─ model-variant-request.service.ts  # Model variant request re-binding
```

---

## 3. Component Responsibilities

| Directory / File | Responsibilities & Design Purpose |
| :--- | :--- |
| **`server/proxy.module.ts`** | **Root Composite Module**. Imports `OpenAIModule`, `AnthropicModule`, `GeminiModule`, and `AccountLeaseModule`, registers shared services, and exports `ProxyService`. |
| **`server/proxy.service.ts`** | **Backward-Compatible Facade**. Keeps external invocation signatures stable while delegating actual protocol handling to sub-services (`OpenAIService`, `AnthropicService`, `GeminiService`). |
| **`common/`** | Provides **shared base classes** (`BaseProxyController`, `BaseProxyService`) for protocol controllers and services, alongside cross-protocol request/response types (`request-interfaces.ts`) and exception definitions. |
| **`guards/`** | Enforces NestJS guards for API Key authentication, admin endpoint authorization, and OpenCode token scope verification. |
| **`modules/openai/`** | Manages OpenAI HTTP controllers and service orchestration; the `responses/` sub-directory handles WebSocket protocol state and session lifecycle. |
| **`modules/anthropic/`** | Handles Anthropic Messages API parsing, request transformation, stream response mapping, and session management. |
| **`modules/gemini/`** | Handles native Gemini REST/SSE endpoints; `gemini-client.service.ts` encapsulates upstream Axios calls, multi-endpoint failover, and explicit context caching. |
| **`modules/files/`** | **Local file store and the three file surfaces**. One `FileContentStore`, one reference expander, and three thin protocol adapters. Nothing outside this directory knows how a handle is spelled. See section 10. |
| **`modules/account-lease/`**| **Account Lease Core**. Employs a Policy design pattern to decouple selection, quota, hydration, and rate-limiting logic into discrete files under `policies/`, coordinated by `AccountLeaseService`. |
| **`shared/services/`** | Houses singleton services shared across feature modules (e.g., `RateLimitTrackerService`, `ProxyRetryService`), ensuring consistent global state across the Proxy Gateway. |

---

## 4. Authoritative State Ownership Table

The following table defines the single, authoritative Nest DI service or store owner for each runtime state domain across the Proxy Gateway module:

| State Domain / Capability | Authoritative Owner Class / Service | Lifetime & Scope | Responsibilities & Ownership Notes |
| :--- | :--- | :--- | :--- |
| **Account Leasing & Sticky Sessions** | `AccountLeaseService` | Nest DI Singleton (`ProxyModule`) | Manages token cache, account rotation, selection policies, and sticky session bindings. |
| **Model Routing Policy** | `ModelRoutingService` | Nest DI Singleton (`ProxyModule`) | Manages model identifier normalization, custom model mappings, wildcard rules, and protocol headers. |
| **Model Availability & Cooldowns** | `ModelAvailabilityService` | Nest DI Singleton (`ProxyModule`) | Manages account-model capability bans, status 404/403/429 cooldowns, and persistent unavailability snapshots. |
| **Rate-Limit & Lockout Tracking** | `RateLimitTrackerService` | Nest DI Singleton (`ProxyModule`) | Centralizes status 429 and quota exhaustion lockout windows; consumed by `AccountLeaseService` and `AccountLeaseLimitPolicy`. |
| **Retry Coordination** | `ProxyRetryService` | Nest DI Singleton (`ProxyModule`) | Coordinates token re-selection, grace retries, exponential backoff, and upstream penalty application. |
| **Generation Constraints & Budgets** | `GenerationConstraintsService` | Nest DI Singleton (`ProxyModule`) | Calculates maximum output token limits and thinking budget caps per account and target model. |
| **Response Sessions (OpenAI Responses)** | `OpenAIResponsesSessionService` | Nest DI Singleton (`ProxyModule`) | Manages `previous_response_id` links, stored responses, stream states, and WebSocket session lifecycles. Backed by a durable, TTL- and size-bounded JSON file under `~/.antigravity-agent/proxy-state/`, so a chain survives an app restart. Bounds are overridable with `AGM_RESPONSES_SESSION_TTL_MS` and `AGM_RESPONSES_SESSION_MAX_ENTRIES`. |
| **Model Route Miss Journal** | `ModelRouteMissJournalService` | Nest DI Singleton (`ProxyModule`) | Records unroutable model ids with a count and a timestamp — nothing else. Durable under `~/.antigravity-agent/proxy-state/`, bounded by `AGM_MODEL_ROUTE_MISS_JOURNAL_MAX_ENTRIES` and `AGM_MODEL_ROUTE_MISS_JOURNAL_TTL_MS`. |
| **Thought Signatures** | `SignatureStore` | Module Store (`antigravity/SignatureStore`) | Caches, decodes, and verifies thought signatures across multi-turn Anthropic/Gemini messages. |
| **Explicit Context Cache** | `ExplicitContextCacheStore` | Module Singleton (`modules/gemini/explicit-context-cache`) | Manages cached prompt contexts, TTLs, and explicit context cache resource handles (`explicitContextCacheManager`). |
| **Uploaded Files** | `FileContentStore` | Nest DI Singleton (`ProxyModule`) | Owns the on-disk content-addressed store under `<userData>/proxy-files`: handles, blobs, the index, size ceilings, TTL and sweeping. The three file controllers and the reference expander are its only clients. |

---

## 5. Architectural Rules & Guidelines for Developers & Agents

When reading, updating, or refactoring code within this directory, strictly follow these rules:

1. **Maintain Stable Facade (Facade Pattern)**
   - The root-level `proxy.service.ts` serves as a stable facade. External modules (such as Electron main process `main.ts` or other NestJS modules) should inject `ProxyService` without tightly coupling to specific protocol sub-services.

2. **Singletons & State Consistency**
   - Policies, Stores in `AccountLeaseModule`, and services under `shared/services/` are singletons. **Never instantiate multiple instances**, as doing so will split in-memory locks, rate-limit trackers, and quota state.

3. **Protocol Isolation & High Cohesion (SRP)**
   - Protocol-specific logic is isolated inside `modules/<protocol>`. Modifying OpenAI feature logic must not touch or break Gemini or Anthropic handlers.

4. **Base Class Inheritance Without Code Duplication**
   - Reusable utilities (e.g., Request ID creation, SSE header formatting, stream idle timeouts) must be inherited from `BaseProxyService` / `BaseProxyController` rather than copy-pasted.

5. **NestJS Dependency Injection Standard**
   - All Services and Policies must be annotated with `@Injectable()` and provided via module metadata. Do not use `new` to instantiate Nest-managed services manually.

---

## 6. Verification & Development Checklist

After modifying files in `server/`, execute the following verification steps in order:

```powershell
# 1. Static Type Checking
npm run type-check

# 2. Unit Testing (covers Gateway routing, Account Lease policies, retry mechanisms)
npm run test

# 3. Linting & Formatting Check
npm run lint

# 4. Process Boot Verification
# Ensure NestJS dependency injection resolves correctly during Electron main process launch and route handlers register without errors
```

For a faster protocol-focused feedback loop, use the scoped suites below before the full test run:

```powershell
npm run test:proxy:conformance # assembled public HTTP/SSE contracts across all three APIs, plus the file store and file surfaces
npm run test:proxy:gemini      # native Gemini REST and SSE wire behavior
npm run test:proxy:openai      # OpenAI request, response, and streaming contracts
npm run test:proxy:anthropic   # Anthropic Messages request, response, and thinking contracts
npm run test:proxy:media       # multipart, image, audio, and media streaming contracts
```

The shared harness in `src/tests/support/proxy-conformance-harness.ts` boots the real Nest/Fastify controllers with deterministic service and account fixtures. `src/tests/support/http-payloads.ts` owns reusable SSE parsing and multipart builders so protocol tests do not maintain divergent wire helpers. Scoped suites supplement rather than replace `npm run test`.

---

## 7. Native Gemini API Support & Honest Limitations

AntigravityManager exposes a native `/v1beta` Gemini REST/SSE adapter over Antigravity's internal Google CloudCode transport (`v1internal`).

### Supported Native Capabilities
- `POST /v1beta/models/{model}:generateContent`: Non-streaming generation preserving candidates, safety ratings, citations, grounding metadata, logprobs, finish reasons, model versions, response IDs, and prompt feedback allow-by-default.
- `POST /v1beta/models/{model}:streamGenerateContent`: Standard SSE streaming emitting bare `GenerateContentResponse` objects (`data: <json>\n\n`) unwrapped from private transport envelopes.
- `POST /v1beta/models/{model}:countTokens` (also `/countTokens`): Prompt token counting over the upstream `v1internal:countTokens` method, returning the public `{ "totalTokens": N }` envelope.
- `GET /v1beta/models` & `GET /v1beta/models/{model}`: Dynamic model discovery advertising truthful supported generation methods (`countTokens`, `generateContent`, `streamGenerateContent`).
- Transport of `contents` (including inline `image/png` and `audio/wav`), `generationConfig`, `tools` declarations, `toolConfig`, `safetySettings`, and text `systemInstruction`.
- Tool declarations (`tools`), tool configuration (`toolConfig`), and function call/response parts (`functionCall`, `functionResponse`) are transported through the adapter; cross-protocol tool IDs, signature ownership, and full tool lifecycle management remain #18.

### Model Routing and Observability
- `GET /v1/models` and `GET /v1beta/models` expose only provider-advertised capability records from current account snapshots. They neither add compatibility aliases nor hide discovered records based on model-family guesses. An id is withheld only on provider evidence, and the evidence is the id's own `ModelDetails`: `requires_lead_in_generation`, `supports_cumulative_context`, and `supports_estimate_token_counter` describe an editor completion loop, not a chat call, so any id carrying one of them is not published. Measured live on 2026-08-08, the two completion ids carry all three, every chat model carries none, and `gemini-3.1-flash-image` carries no scalar flag at all and stays published. Role membership (`agent_model_sorts` for chat, plus `tab_model_ids`, `command_model_ids`, `image_generation_model_ids`, `mquery_model_ids`, `web_search_model_ids`, `commit_message_model_ids`, `audio_transcription_model_ids`) is reported as corroboration but never withholds — it was measured to hide chat-capable models such as `gemini-3-flash`. The dated `NON_CHAT_CATALOG_MODEL_IDS` table in `ModelMapping.ts` is empty: verified live on 0.19.28-local1, all four ids it ever held carry all three markers, so the rule reaches them and the table remains only as an escape hatch for an id the markers cannot read. Withheld ids remain visible, unfiltered, in `GET /v1/model-routes`.
- Those provider facts are read from the account-lease token cache, which copies each account's quota when accounts are loaded. The quota poller announces every refresh (`quota-refresh-notifier`) and the cache adopts it, so a field a new build learned to parse reaches the catalog on the next poll instead of waiting for a proxy restart. Before this hand-off existed the cache kept the snapshot persisted by the previous build for the whole session, which is how the completion-model rule shipped with the `ModelDetails` markers visible on the wire and empty in the index.
- When Google gives a capability an exact recognized display preset (for example, `Gemini 3.5 Flash (High)`), the catalog uses its stable public preset ID and resolves the physical internal ID separately for each account. This provider-backed normalization is visible in route diagnostics and response headers; it is not a user alias or a guessed family substitution.
- New installations have no aliases. User aliases are explicit `alias -> target` rows with an enabled flag; legacy `custom_mapping` and `anthropic_mapping` entries migrate into that editable table without changing their precedence.
- A request without an enabled alias is treated as a canonical model ID. Provider forwarding is accepted only when the selected account advertises both the forwarding rule and its target. No version, tier, image, Claude, GPT, or Gemini sibling is inferred.
- Explicit tier IDs stay on that tier even when a conflicting reasoning-effort value is supplied. Generic registered IDs can adjust generation controls, but model identity is preserved until the selected account supplies an exact physical ID.
- Image-generation metadata and web-search tools never reselect the model. OpenCode synchronization likewise preserves each exact provider-derived model ID and does not collapse tier IDs into a synthetic base model; pre-existing user entries remain untouched.
- Cross-model fallback is disabled. Retries can select another healthy account only when that account proves support for the same resolved model. Unknown models return 404 `model_not_found`, unavailable capability discovery returns 503 `model_catalog_unavailable`, and known models with no current account capacity return 429 `model_capacity_exhausted`.
- Successful OpenAI, Anthropic, and Gemini responses emit `x-antigravity-requested-model`, `x-antigravity-resolved-model`, `x-antigravity-served-model`, `x-antigravity-route-source`, and `x-antigravity-fallback-policy: none`. Standard response and stream payload `model` / `modelVersion` fields remain authoritative when the upstream reports a more specific served version.
- Authenticated `GET /v1/model-routes` keeps aliases out of the standard model catalog while exposing configured routes, canonical targets, per-account availability, recent model-scoped failures, and `unpublished_catalog_ids` for the local UI. Each entry states why: `reason: "completion_model"` when the provider's own `ModelDetails` marks the id as part of the editor completion loop, with `flags` naming the markers that matched, or `reason: "override"` for an id the dated `NON_CHAT_CATALOG_MODEL_IDS` table lists, which today is none. `roles` reports the provider roles the id belongs to when the discovery response mentions it, as corroboration only, as in `{ "id": "chat_20706", "reason": "completion_model", "flags": ["requiresLeadInGeneration", "supportsCumulativeContext", "supportsEstimateTokenCounter"], "roles": ["tab"] }`. Provider role membership never withholds an id — it was measured to hide chat-capable models such as `gemini-3-flash`.

### Explicit Provider Limitations
- **Media & File Support**: The provider has **no file plane**. `google.internal.cloud.code.v1internal.*` exposes no upload method, no `files/*` resource, and no `fileUri` fetch, so nothing this proxy does can store a file on Google's side. The `/v1beta/files`, `/v1/files` and `/upload/v1beta/files` routes are a **local** content-addressed store plus reference expansion — see section 10. Remote file URIs are still never fetched: a `fileUri` this proxy did not issue is rejected, not forwarded. Inline data (`inlineData`) is limited to verified `image/png` and `audio/wav` on confirmed models; other MIME and model combinations remain unverified and model-dependent.
- **CountTokens Scope**: The upstream method accepts only `{ "request": { "model": "models/<id>", "contents": [...] } }`, so `systemInstruction`, `tools`, and `toolConfig` sent alongside the contents are validated but not counted. Counting is a real upstream call routed like any other request: aliases apply, an unknown model returns 404 `model_not_found`, and no local estimation is performed. If the upstream answer omits `totalTokens`, the proxy reports an upstream failure (502 `INTERNAL` on the Gemini surface, 500 `api_error` on the Anthropic one) rather than substituting a fabricated `0`.
- **Embeddings**: `embedContent` and `batchEmbedContents` return HTTP 501 `UNIMPLEMENTED`. CodeAssist has no embedding method; Google's own `gemini-cli` client throws unconditionally in `CodeAssistServer.embedContent`.
- **Batches**: The provider has **no batch plane** — no batch resource, no deferred submission, no server-side job. `batchGenerateContent`, `/v1/batches` and `/v1/messages/batches` are served by a **local** deferred-job runner over the same `generateContent` calls the interactive endpoints make; see section 11. There is no 50% discount, no separate quota pool, and no separate rate limit.
- **Public Context Cache CRUD**: Client `cachedContent` references are rejected with HTTP 501 `UNIMPLEMENTED`. Automatic explicit context caching runs internally on Vertex AI without exposing public cache resource APIs (`cachedContents/*`).
- **Live / Bidi & Interactions**: Gemini Live WebSocket (Bidi) and Interactions APIs are unavailable under this adapter.
- **Client Tier & Store Parameters**: Top-level `serviceTier` and `store` fields are explicitly rejected with HTTP 501 `UNIMPLEMENTED`.
- **Unsupported Resource Families**: The remaining unsupported Gemini resource families (`tunedModels`, `corpora`, `cachedContents`, `batchJobs`) return HTTP 501 `UNIMPLEMENTED` or 404 `NOT_FOUND`. `files` is served locally (section 10); resumable uploads within it are not implemented. `operations` is served locally too, but only `list` and `get`, and only for batches this proxy created (section 11).
- **Partial Model Resources**: Antigravity does not expose authoritative `baseModelId`, `version`, input/output limits, temperature limits, or defaults. Model list/detail responses deliberately omit those fields instead of fabricating values, so they are a compatibility subset of Google's full `Model` resource.
- **Capability Freshness**: Antigravity's quota response has no authoritative observation timestamp. `checked_at` reports when diagnostics were assembled, not when Google produced the capability snapshot. A listed model is provider-advertised, not a guarantee that the next generation call will succeed.
- **Negative Evidence Is Account-Scoped**: A 404 marks only that account-model pair unsupported; quota and rate-limit failures use expiring cooldowns. The proxy does not convert those failures into permanent global removal and never reroutes to a sibling model.
- **Quota Identity Is Exact**: Zero-percent quota entries are excluded before selection. Recovery clears only the exact model ID or an alias linked by a Google-provided forwarding rule; similar version, tier, or family names do not share state implicitly.
- **Request Deadline**: `request_timeout` is one end-to-end budget for upstream setup and completion across project-header retries, internal endpoint failover, account retries, backoff, and non-stream/stream fallback. It is not reset for each attempt. After a live SSE handshake, the separate five-minute idle timeout governs gaps between events. Callers cannot currently override this deadline per request.
- **Streaming Identity**: Response headers are fixed when the SSE handshake starts and therefore name the physical model selected for the upstream request. If Google later reports a different `modelVersion`, the streamed payload is authoritative because HTTP headers cannot be rewritten after emission.
- **Slow SSE Consumers**: Disconnects, malformed events, premature closes, and the five-minute idle timeout destroy the exact upstream stream. A full downstream socket now pauses the upstream readable until `drain`; already-buffered bytes inside Node or the operating system remain outside application control.
- **Streaming Retry Boundary**: Once response bytes have crossed the SSE handshake, the proxy cannot transparently retry without duplicating or reordering client-visible events. A failure before live streaming starts can use a buffered non-stream response to synthesize protocol-correct SSE, but that fallback is not genuine upstream token streaming.

---

## 8. OpenAI Chat Completions and Legacy Completions Contract

### Supported Chat Completions Surface

- `POST /v1/chat/completions` supports non-stream and SSE responses, multiple candidates (`n`), `stop`, `max_tokens` / `max_completion_tokens`, OpenAI sampling defaults and controls, penalties, `seed`, tools, explicit `tool_choice`, structured JSON output, non-stream logprobs, `user`, and `service_tier=auto|default`.
- JSON output maps to Gemini `responseMimeType` and the supported Gemini JSON Schema subset. `n` maps to `candidateCount`; every returned candidate keeps its index and finish reason.
- Non-stream logprobs map Gemini chosen/top candidate token data to the OpenAI Chat logprobs shape, including UTF-8 byte arrays. If upstream omits logprob data, the choice returns `logprobs: null`.
- Streaming emits an initial assistant-role chunk per choice, independent per-choice tool indexes and finish reasons, one `[DONE]`, and 15-second SSE comment heartbeats. With `stream_options.include_usage=true`, ordinary chunks contain `usage: null` and one final empty-choices chunk contains aggregate usage.
- Client disconnect/cancellation destroys the exact upstream readable. An upstream error, idle timeout, or close before all requested choices finish is surfaced as a stream error and never disguised as a successful `[DONE]`.
- Base64 `data:image/*` Chat content parts are transported. Remote image URLs are rejected rather than silently converted to prompt text.

### Legacy `/v1/completions` Surface

- A single string prompt (or a one-element string array) is translated through the Chat transport while responses use genuine `text_completion` objects and `cmpl-*` IDs.
- Streaming converts every Chat chunk, choice, finish reason, and optional final usage chunk to the legacy wire shape. It does not leak `chat.completion.chunk` objects.
- Batched prompt arrays, token-ID prompts, `best_of>1`, `echo=true`, suffix insertion, and legacy logprobs return HTTP 400 `invalid_request_error`; their semantics cannot be represented faithfully by this transport.

### Explicit Compatibility Limits

- Streaming Chat logprobs are rejected because the internal Gemini stream does not expose stable per-token logprob events. Non-empty `logit_bias`, `store=true`, `parallel_tool_calls=false` with tools, unsupported reasoning tiers, and unknown request controls also return HTTP 400 instead of being ignored.
- Only reasoning efforts `low`, `medium`, and `high` are mapped. Known non-reasoning or tool-less model variants reject incompatible controls before the upstream call.
- `service_tier=auto|default` reports `default`; priority/flex/scaled tiers are not available. `metadata` and `user` can supply stable session identity, but this proxy does not implement OpenAI stored-completion retrieval.
- Gemini structured output implements a subset of JSON Schema. Schemas accepted by OpenAI but rejected by Gemini remain upstream validation errors; the proxy does not weaken them silently.
- `candidateCount>1`, response logprobs, and some penalties are declared by Gemini's generation contract but can still be model-, account-, or internal-endpoint-dependent. Such upstream rejection is not rewritten as success.
- A stream interrupted before the final usage event has no authoritative usage total. This matches the OpenAI warning that interrupted streams may not deliver the final usage chunk.
- Response `model` reports the physical model used for the upstream request and can be refined by an upstream `modelVersion`. The requested alias, resolved target, selected physical model, route source, and disabled fallback policy are also exposed through `x-antigravity-*` response headers; account identity is intentionally not exposed.
- HTTP error typing for upstream quota/access/routing failures is handled by the shared retry/error layer. The Chat validator only owns deterministic client-side 400 errors.

---

## 9. Anthropic Messages API Contract

`POST /v1/messages` is an Anthropic-compatible adapter over Antigravity's Gemini/Claude transport. It follows the public [Messages request](https://platform.claude.com/docs/en/api/messages/create), [SSE event](https://platform.claude.com/docs/en/build-with-claude/streaming), and [error](https://platform.claude.com/docs/en/api/errors) envelopes where the upstream transport can preserve their meaning.

### Supported Messages Surface

- Top-level text `system` blocks plus ordered `user` and `assistant` messages containing text, base64 images, client-side `tool_use` / `tool_result` blocks, and supported thinking blocks.
- Client tool schemas, automatic/any/specific/none tool choice, parallel tool calls, immediate parallel tool-result batches, sampling controls, caller stop sequences, metadata-derived session identity, and caller-selected output limits.
- Non-stream responses use Anthropic message/content/usage shapes. SSE uses named Anthropic events (`message_start`, content-block events, `message_delta`, `message_stop`) without an OpenAI `[DONE]` marker.
- Stream interruption, parse failure, upstream failure, and idle timeout close any active content block and emit a terminal Anthropic `event: error`. They are not reported as successful `message_stop` events.
- Client disconnects remove the installed listeners and destroy the exact upstream readable. Messages requests use Anthropic's 32 MiB request limit; each inline image remains limited to 5 MiB by the adapter.
- Deterministic request failures return Anthropic error types, a `request_id` field, and a `request-id` response header. Upstream overload is exposed as HTTP 529 `overloaded_error`.
- `POST /v1/messages/count_tokens` accepts the counting subset of the Messages body (`model`, `messages`, `system`, `tools`, `tool_choice`, `thinking`; generation-only fields are rejected) and returns `{"input_tokens": N}`. The body is converted by the same mapper the Messages endpoint uses, so the counted conversation is the one a real completion would send; see the CountTokens scope note in section 7 for what the upstream method does and does not count.

### Explicit Compatibility Limits

- This is a translation adapter, not Anthropic's hosted control plane. Admin APIs, server tools, container execution, MCP connectors, and Anthropic-side prompt-cache creation are unavailable. The Files API is served by the proxy's own local store (section 10) and Message Batches by the proxy's own local runner (section 11), not by Anthropic.
- Anthropic prompt-cache controls are accepted as inert compatibility metadata. Usage cannot report genuine Anthropic cache creation; a Gemini implicit-cache hit is not equivalent to Anthropic cache semantics.
- `redacted_thinking` is rejected because Anthropic ciphertext cannot be converted into a valid Gemini thought signature. `thinking.display` is also unavailable. Supported opaque thought signatures are round-tripped only when the upstream transport supplies compatible signature bytes.
- Structured output via `output_config.format`, deferred/strict tools, and `disable_parallel_tool_use=true` are rejected instead of being silently weakened. Gemini cannot guarantee those Anthropic execution semantics through this path.
- Inline images are restricted to verified JPEG, PNG, and WebP base64 sources. Anthropic-supported GIF and URL sources are rejected because this proxy has no faithful upstream representation for them. A `{"type":"file","file_id":…}` image or document source is accepted and resolved against the proxy's own local file store (section 10); after expansion an image source must still land on one of the three verified image types.
- Custom stop strings are forwarded, but the internal response does not identify which string matched. Therefore `stop_reason` can be preserved while `stop_sequence` may remain `null` instead of fabricating an attribution.
- Thinking budget is constrained to fit the effective output-token cap. Some native Anthropic interleaved-thinking combinations allow budgets that this Gemini transport cannot represent and are rejected locally.
- For special unregistered Claude thinking presets, the upstream-compatible request recipe may still remove stop sequences. Registered model variants retain caller stops and clamp, but never increase, `max_tokens`.
- `anthropic-version` is accepted by the HTTP compatibility surface but does not select different proxy schemas. Newly introduced Anthropic fields are rejected until the adapter explicitly supports their semantics.

---

## 10. Files API — A Local Store, Not a Provider File Plane

### What this actually is

`google.internal.cloud.code.v1internal.*` on `cloudcode-pa.googleapis.com` has **no file plane**: no upload method, no `files/*` resource, and no `fileUri` fetch. That was read out of the vendor's own protobuf descriptors, not inferred; see `docs/antigravitymanager_api_surface_matrix_2026-08-08.md`. What the generate call does accept is `inlineData { mimeType, data }`.

So the Files API here is a **local content-addressed store plus reference expansion**. A client uploads once and gets a handle; every later request naming that handle has it expanded into an `inlineData` part on the way upstream. That is a real implementation of the client-visible contract — uploads persist across requests and restarts, handles resolve, and a multi-turn conversation stops re-sending megabytes of base64 over the client link.

It is **not** provider-side storage, and it delivers **none of the token savings** a real server-side file cache would give: the bytes still travel to Google inline on every request that references them, exactly as they did before. Anything claiming otherwise would be false.

### The store

`FileContentStore` (`modules/files/file-content-store.service.ts`) is the single owner, protocol-agnostic, with a narrow interface: `put`, `get`, `stat`, `list`, `delete`, `sweep`. It holds policy only; every path, atomic rename and index parse lives in `file-store-disk.ts`. The store lives at `<userData>/proxy-files`.

| Property | Behaviour |
| :--- | :--- |
| **Addressing** | Handles are the first 32 hex characters of the content's sha256. Uploading identical bytes twice returns the same handle over one blob; the repeat refreshes the expiry and adopts a newly supplied display name. |
| **Size ceilings** | 20 MiB per file, 512 MiB per store, both configurable through `FILE_STORE_OPTIONS`. Either ceiling produces a `413`-shaped protocol error in the caller's own dialect. |
| **TTL** | 48 hours, matching the lifetime Google documents for its own Files API. Expired handles resolve to an explicit *expired* error, never to a silently empty part. Sweeps run at startup, on a 15-minute timer, and before every listing. |
| **Crash safety** | Content is written to `tmp/` and renamed into place, so a half-written blob is never addressable. The index is a JSON document written the same way; a torn or truncated index starts empty rather than throwing, and orphaned blobs are reclaimed on the next load. |
| **MIME handling** | The declared type is trusted only after a magic-byte sniff. Both are stored; the sniffed one wins when they disagree, because the upstream call validates the bytes and not the label. A recognised text payload keeps a more specific declared text type (`text/csv` over `text/plain`). |
| **Path safety** | Handles are opaque ids this proxy generates and are matched against `^[0-9a-f]{32}$`. A client-supplied string never reaches the filesystem; `../` is reported as "never issued" rather than sanitised. |
| **Privacy** | The store holds user documents. File contents are never logged and filenames never enter telemetry. |

### Routes

| Surface | Routes |
| :--- | :--- |
| **Gemini** | `POST /upload/v1beta/files` (simple media and multipart forms; resumable is not implemented), `GET /v1beta/files`, `GET /v1beta/files/{name}`, `DELETE /v1beta/files/{name}`. Returns the documented `File` resource with `state: "ACTIVE"` — there is no processing step, so no `PROCESSING` phase is invented. `uri` names this proxy, because that is where the bytes are. |
| **OpenAI** | `POST /v1/files`, `GET /v1/files`, `GET /v1/files/{id}`, `GET /v1/files/{id}/content`, `DELETE /v1/files/{id}`. Ids are `file-…`. Only `user_data`, `vision`, `assistants_input` and `batch` purposes are accepted; `fine-tune`, `evals` and the Assistants output purposes are rejected at upload naming the supported set, rather than stored and left useless. `batch` is accepted because `/v1/batches` reads its input JSONL back out of this store (section 11); the runner writes its results back with purpose `batch_output`. |
| **Anthropic** | The same five routes, ids `file_…`, gated behind `anthropic-beta: files-api-2025-04-14`. |

**Why one controller serves two dialects.** OpenAI and Anthropic both publish their Files API at exactly `/v1/files`, so a single route table has to answer both. `ClientFilesController` picks the dialect per request: any `anthropic-version` or `anthropic-beta` header means the Anthropic dialect, everything else is OpenAI. Each dialect's shapes, errors and upload rules live in its own adapter module (`openai-file-resource.ts`, `anthropic-file-resource.ts`) beside the controller. **The Anthropic beta header is required** — deliberately, since it is also how a request declares which dialect it wants; the error when it is missing names the header. Gemini has its own controller (`GeminiFilesController`) because its paths do not collide.

All three are views over the same store, so a file uploaded through one surface can be referenced from any of them.

### Reference expansion

`file-reference-expander.ts` is the single resolution routine. It runs on the raw request body **before** validation, because the request contracts reject content parts they do not recognise and a `file_id` part only becomes recognisable once resolved.

| Surface | Accepted reference | Becomes |
| :--- | :--- | :--- |
| Gemini | `fileData { fileUri, mimeType }` | `inlineData` |
| OpenAI Chat | `{"type":"file","file":{"file_id":…}}` | `image_url` data URL for images, `file.file_data` otherwise |
| OpenAI Responses | `{"type":"input_image","file_id":…}`, `{"type":"input_file","file_id":…}` | inline `image_url` / `file_data` |
| Anthropic | `{"type":"image"\|"document","source":{"type":"file","file_id":…}}` | base64 source |

Every path converges on a Gemini `inlineData` part. Non-image documents ride an Anthropic-shaped `document` block, which `ClaudeRequestMapper` maps to the same `inlineData` an image block produces.

Expansion is **fail-closed**. A handle this proxy never issued, or one that has expired, is an error in the caller's own dialect; it is never dropped, never forwarded upstream as an opaque URI, and never replaced with an empty part. Handles are accepted in every spelling the surfaces hand out — bare id, `files/{id}`, `file-{id}`, `file_{id}`, and the full `uri`.

### Boot requirements

`src/server/main.ts` registers a buffer content-type parser for the media families so Google's simple upload form (whole body is the file, `Content-Type` names its type) reaches the handler. `application/json` and `multipart/form-data` keep their existing exact-match parsers, so no other route changes behaviour. Upload routes get their own body limit in `src/server/proxy-body-limit.ts`.

---

## 11. Batch API — A Local Deferred-Job Runner, Not a Provider Batch Service

### What this actually is

The provider has **no batch plane**. A live sweep on 2026-08-09 found `POST /v1/batches`, `GET /v1/messages/batches` and `POST /v1/messages/batches` answering the framework's 404, and `:batchGenerateContent` answering a plain `501`. There is no batch resource, no deferred submission and no server-side job to hand work to.

So the Batch API here is a **local deferred-job runner** over the same `generateContent` calls the proxy already makes. That is a real implementation of the client-facing contract — submit a set of requests, poll, collect results line by line, survive a dropped connection and an app restart — and it is worth having for clients that only speak batch.

It is **not** the economics of a real batch API: **there is no 50% discount, no separate quota pool, and no separate rate limit. Every request costs exactly what it would cost sent normally.** Anything claiming otherwise would be false. The only thing a batch buys is scheduling: the work happens later, slower, and without holding a connection open.

### The runner

`BatchRunnerService` (`modules\batch\batch-runner.service.ts`) is the single owner, protocol-agnostic, over one `DurableRecordStore` — the same store kanban #49 built, not a third one. State lives at `<userData>\proxy-batches.json`, written through `atomic-json-file`.

| Property | Behaviour |
| :--- | :--- |
| **Durability** | Every state change is persisted before it is observable. A record the file says was `running` cannot have finished, because the outcome is written before the state leaves `running`; on the next start it is reset to `pending` and retried from the top. A fresh runner over the same file resumes mid-flight batches without any in-memory carry-over. |
| **Concurrency** | Two requests at a time by default, `AGM_BATCH_MAX_CONCURRENCY` to change it. Deliberately tiny: the proxy has **no global concurrency limiter**. `AccountLeaseService.getNextToken()` hands out an account per request and `RateLimitTrackerService` only reacts to upstream 429s by locking that account out — a lockout the interactive path then shares. A batch is by definition not urgent, so it stays well below what an interactive client would use rather than competing with one. |
| **Lease cooperation** | Batch requests go through `ProxyService.handleChatCompletions` / `handleAnthropicMessages` / `handleGeminiGenerateContent` unchanged. There is no second path upstream: account selection, model routing, retries and rate-limit tracking all apply exactly as they do to an interactive call. |
| **Failure isolation** | A failing request records its error against its own `custom_id` and the batch keeps going. One bad line never aborts the rest. |
| **Cancellation** | `cancel` moves the batch to `cancelling` and cancels every request that had not started. One already dispatched upstream is **not** aborted — the cost is already incurred and the connection cannot be un-sent — but its answer is discarded and recorded as `canceled`, which is why the batch sits in `cancelling` until it settles. |
| **Expiry** | `completion_window` is the processing deadline (24 h). Past it, requests that never ran become `expired` and the batch becomes `expired`; ones that already ran keep their real outcome, because they really did cost what they cost. |
| **TTL** | Records are retained for 48 hours, matching the file store's handle lifetime, then evicted with the store's own bound of 200 batches. Output and error files age out on the file store's own 48-hour TTL. |
| **Ordering** | Oldest batch first, so a long queue is not starved by newer arrivals. |

### Routes

| Surface | Routes |
| :--- | :--- |
| **OpenAI** | `POST /v1/batches` (`input_file_id`, `endpoint`, `completion_window`, `metadata`), `GET /v1/batches`, `GET /v1/batches/{id}`, `POST /v1/batches/{id}/cancel`. Ids are `batch_…`. Input and output are JSONL through the local Files API: the input is read from the store by `input_file_id`, and the results are written back into it and referenced as `output_file_id` / `error_file_id`. |
| **Anthropic** | `POST /v1/messages/batches` with the inline `requests` array (no file needed), `GET /v1/messages/batches`, `GET /v1/messages/batches/{id}`, `GET /v1/messages/batches/{id}/results`, `POST /v1/messages/batches/{id}/cancel`, `DELETE /v1/messages/batches/{id}`. Ids are `msgbatch_…`. |
| **Gemini** | `POST /v1beta/models/{model}:batchGenerateContent` answers with a long-running operation; poll it at `GET /v1beta/operations/{name}` or list with `GET /v1beta/operations`. |

**Endpoints a batch may name.** `/v1/chat/completions` and `/v1/responses` only. Anything else is rejected at creation naming the supported set. `/v1/embeddings` is called out by name in the rejection message because there is no embedding RPC on this transport at all — established from the vendor's protobuf descriptors and corroborated by `gemini-cli` implementing `embedContent()` as a `throw`. It cannot be batched because it cannot be served.

**Completion window.** `24h` only, which is the only value OpenAI documents. Any other value is rejected rather than accepted and quietly ignored.

**How a batch declares its dialect.** It does not have to. `/v1/files` needed a header signal because OpenAI and Anthropic publish that resource at the same path; batches do not — OpenAI's is `/v1/batches` and Anthropic's is `/v1/messages/batches`, so the path already says which dialect is being spoken and no header is consulted. `anthropic-beta` is accepted and ignored rather than required: Message Batches is generally available at Anthropic, so demanding a beta header would refuse requests their own current SDKs send. This was checked against the route table rather than assumed.

**Statuses.** The runner's internal vocabulary is OpenAI's documented one — `validating`, `in_progress`, `finalizing`, `completed`, `failed`, `cancelling`, `cancelled`, `expired` — because it is the most granular of the three, and each adapter maps it onto its own. Anthropic reports `in_progress` / `canceling` / `ended`; Gemini reports a `BatchState` inside the operation metadata. No status is invented on any surface. `request_counts` is recomputed from the live request records on every read, so it is never ahead of reality.

**Result shapes.** OpenAI output lines are `{id, custom_id, response: {status_code, request_id, body}, error}`; successes go to the output file and everything else to the error file. Anthropic result lines are `{custom_id, result: {type: "succeeded" | "errored" | "canceled" | "expired", …}}`, served as JSONL from `/results` once the batch has ended. Gemini's completed operation carries `response.inlinedResponses.inlinedResponses`, one entry per request, keyed by the `metadata.key` the request was submitted with.

**What is not implemented.** Gemini's file-input form of `:batchGenerateContent` — this runner's inputs are request bodies, not stored blobs, and accepting a handle it would have to reject at execution time would be worse than refusing it at submission. `operations.cancel` and `operations.delete` are absent too: cancellation belongs to the batch, and this proxy will not publish an operations control plane it does not have.

### Legacy `/v1/complete`

Anthropic's deprecated Text Completions endpoint, served as a thin adapter over the Messages path rather than left as a bare 404. The `\n\nHuman: … \n\nAssistant:` prompt is parsed back into turns (a prefilled assistant turn is kept, because that is what it meant on the old endpoint; a prompt with no markers at all becomes a single user turn), `max_tokens_to_sample` becomes `max_tokens`, and the Messages response is rendered back as `{type, id, completion, stop_reason, stop, model}` with the leading space the old API always emitted.

Streaming is refused with a 400 rather than half-served: the old `completion` event stream is a different wire format from the Messages SSE this proxy produces, and returning Messages events to a Text Completions client would be worse than a clear error.
