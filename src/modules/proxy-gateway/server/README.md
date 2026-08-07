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
| **Response Sessions (OpenAI Responses)** | `OpenAIResponsesSessionStore` | Module Singleton Store (`modules/openai/responses`) | Manages `previous_response_id` links, stream states, and WebSocket session lifecycles for OpenAI responses. |
| **Thought Signatures** | `SignatureStore` | Module Store (`antigravity/SignatureStore`) | Caches, decodes, and verifies thought signatures across multi-turn Anthropic/Gemini messages. |
| **Explicit Context Cache** | `ExplicitContextCacheStore` | Module Singleton (`modules/gemini/explicit-context-cache`) | Manages cached prompt contexts, TTLs, and explicit context cache resource handles (`explicitContextCacheManager`). |

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
npm run test:proxy:conformance # assembled public HTTP/SSE contracts across all three APIs
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
- `GET /v1beta/models` & `GET /v1beta/models/{model}`: Dynamic model discovery advertising truthful supported generation methods (`generateContent`, `streamGenerateContent`).
- Transport of `contents` (including inline `image/png` and `audio/wav`), `generationConfig`, `tools` declarations, `toolConfig`, `safetySettings`, and text `systemInstruction`.
- Tool declarations (`tools`), tool configuration (`toolConfig`), and function call/response parts (`functionCall`, `functionResponse`) are transported through the adapter; cross-protocol tool IDs, signature ownership, and full tool lifecycle management remain #18.

### Model Routing and Observability
- `GET /v1/models` and `GET /v1beta/models` expose only provider-advertised capability records from current account snapshots. They neither add compatibility aliases nor hide discovered records based on model-family guesses.
- When Google gives a capability an exact recognized display preset (for example, `Gemini 3.5 Flash (High)`), the catalog uses its stable public preset ID and resolves the physical internal ID separately for each account. This provider-backed normalization is visible in route diagnostics and response headers; it is not a user alias or a guessed family substitution.
- New installations have no aliases. User aliases are explicit `alias -> target` rows with an enabled flag; legacy `custom_mapping` and `anthropic_mapping` entries migrate into that editable table without changing their precedence.
- A request without an enabled alias is treated as a canonical model ID. Provider forwarding is accepted only when the selected account advertises both the forwarding rule and its target. No version, tier, image, Claude, GPT, or Gemini sibling is inferred.
- Explicit tier IDs stay on that tier even when a conflicting reasoning-effort value is supplied. Generic registered IDs can adjust generation controls, but model identity is preserved until the selected account supplies an exact physical ID.
- Image-generation metadata and web-search tools never reselect the model. OpenCode synchronization likewise preserves each exact provider-derived model ID and does not collapse tier IDs into a synthetic base model; pre-existing user entries remain untouched.
- Cross-model fallback is disabled. Retries can select another healthy account only when that account proves support for the same resolved model. Unknown models return 404 `model_not_found`, unavailable capability discovery returns 503 `model_catalog_unavailable`, and known models with no current account capacity return 429 `model_capacity_exhausted`.
- Successful OpenAI, Anthropic, and Gemini responses emit `x-antigravity-requested-model`, `x-antigravity-resolved-model`, `x-antigravity-served-model`, `x-antigravity-route-source`, and `x-antigravity-fallback-policy: none`. Standard response and stream payload `model` / `modelVersion` fields remain authoritative when the upstream reports a more specific served version.
- Authenticated `GET /v1/model-routes` keeps aliases out of the standard model catalog while exposing configured routes, canonical targets, per-account availability, and recent model-scoped failures for the local UI.

### Explicit Provider Limitations
- **Media & File Support**: No native Gemini File API routes (`files/*`) or remote file URI resolution exist. Inline data (`inlineData`) is limited to verified `image/png` and `audio/wav` on confirmed models; other MIME and model combinations remain unverified and model-dependent.
- **CountTokens**: Returns HTTP 501 `UNIMPLEMENTED` with a Google-shaped error envelope. Local token estimation is not performed.
- **Embeddings & Batches**: `embedContent`, `batchEmbedContents`, and `batchGenerateContent` return HTTP 501 `UNIMPLEMENTED`.
- **Public Context Cache CRUD**: Client `cachedContent` references are rejected with HTTP 501 `UNIMPLEMENTED`. Automatic explicit context caching runs internally on Vertex AI without exposing public cache resource APIs (`cachedContents/*`).
- **Live / Bidi & Interactions**: Gemini Live WebSocket (Bidi) and Interactions APIs are unavailable under this adapter.
- **Client Tier & Store Parameters**: Top-level `serviceTier` and `store` fields are explicitly rejected with HTTP 501 `UNIMPLEMENTED`.
- **Unsupported Resource Families**: All unsupported Gemini resource families (`files`, `tunedModels`, `corpora`, `cachedContents`, `batchJobs`, `operations`) return HTTP 501 `UNIMPLEMENTED` or 404 `NOT_FOUND`.
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

### Explicit Compatibility Limits

- This is a translation adapter, not Anthropic's hosted control plane. Message Batches, token counting, Files, Admin APIs, server tools, container execution, MCP connectors, and Anthropic-side prompt-cache creation are unavailable.
- Anthropic prompt-cache controls are accepted as inert compatibility metadata. Usage cannot report genuine Anthropic cache creation; a Gemini implicit-cache hit is not equivalent to Anthropic cache semantics.
- `redacted_thinking` is rejected because Anthropic ciphertext cannot be converted into a valid Gemini thought signature. `thinking.display` is also unavailable. Supported opaque thought signatures are round-tripped only when the upstream transport supplies compatible signature bytes.
- Structured output via `output_config.format`, deferred/strict tools, and `disable_parallel_tool_use=true` are rejected instead of being silently weakened. Gemini cannot guarantee those Anthropic execution semantics through this path.
- Inline images are restricted to verified JPEG, PNG, and WebP base64 sources. Anthropic-supported GIF, URL, and Files API sources are rejected because this proxy has no faithful upstream representation for them.
- Custom stop strings are forwarded, but the internal response does not identify which string matched. Therefore `stop_reason` can be preserved while `stop_sequence` may remain `null` instead of fabricating an attribution.
- Thinking budget is constrained to fit the effective output-token cap. Some native Anthropic interleaved-thinking combinations allow budgets that this Gemini transport cannot represent and are rejected locally.
- For special unregistered Claude thinking presets, the upstream-compatible request recipe may still remove stop sequences. Registered model variants retain caller stops and clamp, but never increase, `max_tokens`.
- `anthropic-version` is accepted by the HTTP compatibility surface but does not select different proxy schemas. Newly introduced Anthropic fields are rejected until the adapter explicitly supports their semantics.
