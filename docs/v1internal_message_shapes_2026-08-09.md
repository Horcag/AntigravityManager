# v1internal message shapes (2026-08-09)

## Evidence and limits

All rows in the table are read directly from `language_server.exe` build 2026-08-07,
using the raw `FileDescriptorProto` data embedded by the Go protobuf runtime. The
decoder is dependency-free: [scripts/extract-v1internal-descriptors.mjs](../scripts/extract-v1internal-descriptors.mjs).
It reads the descriptor's service methods and first-level request fields; it does
not establish which optional fields are required by server-side validation.

The JSON names below are protobuf JSON names. `repeated` only describes cardinality;
all other fields are singular. No row is inferred from HTTP errors or guessed request
bodies. `StreamGenerateChat` and `TabChat` are server-streaming according to their
method descriptors.

## The eight probed verbs

| HTTP verb                   | Request message                                                          | Response message                                                          | Request fields from descriptor                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateChat`              | `google.internal.cloud.code.v1internal.GenerateChatRequest`              | `google.internal.cloud.code.v1internal.GenerateChatResponse`              | `project`, `requestId`, `userMessage`, `history` (repeated `ChatMessage`), `ideContext` (`IDEContext`), `metadata` (`ClientMetadata`), `enablePromptEnhancement`, `yieldInfo` (`YieldInfo`), `yieldedUserInput` (`GenerateChatRequest.YieldedUserInput`), `retryDetails` (`RetryDetails`), `functionDeclarations` (repeated `FunctionDeclaration`), `includeThinkingSummaries`, `tierId`, `modelConfigId`, `userPromptId` |
| `streamGenerateChat`        | `google.internal.cloud.code.v1internal.GenerateChatRequest`              | `google.internal.cloud.code.v1internal.GenerateChatResponse`              | Same `GenerateChatRequest` fields as `generateChat`; method is server-streaming.                                                                                                                                                                                                                                                                                                                                          |
| `tabChat`                   | `google.internal.cloud.code.v1internal.TabChatRequest`                   | `google.internal.cloud.code.v1internal.TabChatResponse`                   | `project`, `request` (`exa.api_server_pb.GetChatMessageRequest`); method is server-streaming. The nested external `request` type explains why a `GenerateContentRequest`-shaped value was rejected.                                                                                                                                                                                                                       |
| `completeCode`              | `google.internal.cloud.code.v1internal.CompleteCodeRequest`              | `google.internal.cloud.code.v1internal.CompleteCodeResponse`              | `project`, `requestId`, `ideContext` (`IDEContext`), `metadata` (`ClientMetadata`), `enablePromptEnhancement`, `userContext` (`UserContext`), `tierId`                                                                                                                                                                                                                                                                    |
| `generateCode`              | `google.internal.cloud.code.v1internal.GenerateCodeRequest`              | `google.internal.cloud.code.v1internal.GenerateCodeResponse`              | `project`, `requestId`, `ideContext` (`IDEContext`), `metadata` (`ClientMetadata`), `enablePromptEnhancement`, `tierId`                                                                                                                                                                                                                                                                                                   |
| `transformCode`             | `google.internal.cloud.code.v1internal.TransformCodeRequest`             | `google.internal.cloud.code.v1internal.TransformCodeResponse`             | `project`, `requestId`, `ideContext` (`IDEContext`), `userPrompt`, `command` (`TransformCodeRequest.Command`), `metadata` (`ClientMetadata`), `enablePromptEnhancement`, `tierId`                                                                                                                                                                                                                                         |
| `internalAtomicAgenticChat` | `google.internal.cloud.code.v1internal.InternalAtomicAgenticChatRequest` | `google.internal.cloud.code.v1internal.InternalAtomicAgenticChatResponse` | `project`, `requestId`, `userMessage`, `history` (repeated `AgenticChatMessage`), `ideContext` (`IDEContext`), `metadata` (`ClientMetadata`), `enablePromptEnhancement`, `toolDefinitions` (repeated `ToolDefinition`)                                                                                                                                                                                                    |
| `listModelConfigs`          | `google.internal.cloud.code.v1internal.ListModelConfigsRequest`          | `google.internal.cloud.code.v1internal.ListModelConfigsResponse`          | `metadata` (`ClientMetadata`), `domain` (`ListModelConfigsRequest.Domain`)                                                                                                                                                                                                                                                                                                                                                |

## Offline extraction

Run this command without starting the sidecar or contacting the proxy:

```powershell
node scripts/extract-v1internal-descriptors.mjs
```

The scanner intentionally accepts only a raw descriptor with package
`google.internal.cloud.code.v1internal`. It stops parsing a descriptor before the
next top-level filename field, which avoids treating an adjacent Go data symbol as
part of the same `FileDescriptorProto`. The fixture test is independent of the
sidecar binary:

```powershell
node --test scripts/extract-v1internal-descriptors.test.mjs
```

## One-command probe candidates

The diagnostic proxy must already be running with `AGM_V1INTERNAL_PASSTHROUGH=1`.
Set its key as `AGM_PROXY_API_KEY`; `AGM_PROXY_URL` optionally replaces the default
`http://127.0.0.1:8045`. The helper prints the HTTP status followed by the raw body
and never starts the application itself.

```powershell
$env:AGM_PROXY_API_KEY = '<proxy-api-key>'
node scripts/probe-v1internal-shapes.mjs generateChat
node scripts/probe-v1internal-shapes.mjs streamGenerateChat
node scripts/probe-v1internal-shapes.mjs tabChat
node scripts/probe-v1internal-shapes.mjs completeCode
node scripts/probe-v1internal-shapes.mjs generateCode
node scripts/probe-v1internal-shapes.mjs transformCode
node scripts/probe-v1internal-shapes.mjs internalAtomicAgenticChat
node scripts/probe-v1internal-shapes.mjs listModelConfigs
```

Each command uses the descriptor-derived default body in
[scripts/probe-v1internal-shapes.mjs](../scripts/probe-v1internal-shapes.mjs). Replace
it only when testing a more specific candidate:

```powershell
node scripts/probe-v1internal-shapes.mjs listModelConfigs '{"domain":"DOMAIN_STREAMING_CHAT"}'
```
