# OpenAI-compatible media endpoints

The local proxy exposes these OpenAI-compatible endpoints:

- GET /v1/models and GET /v1/models/:model
- POST /v1/chat/completions
- POST /v1/completions
- POST /v1/responses
- POST /v1/images/generations
- POST /v1/images/edits
- POST /v1/audio/transcriptions
- POST /v1/messages for the Anthropic-compatible surface

Multipart error handling recognizes one optional trailing slash on the three media routes. Other route matching is unchanged.

## Media constraints

- Images support generation and edits. Image edits accept JSON base64 or multipart image inputs, permit at most 16 image inputs, and return PNG b64_json output.
- Audio supports transcription. It accepts JSON base64 or multipart audio input and supports response_format=json or response_format=text.
- JSON media input must contain valid base64 data. Invalid image, reference-image, file, or audio values are rejected locally with an OpenAI-shaped 400 error before upstream work starts.
- Multipart files retain the existing 25 MiB per-file limit. Malformed multipart requests are reported as multipart_parse_error.
- Repeated multipart scalar fields are collected in arrival order; scalar option resolution uses the last received value. This documents the current proxy behavior and does not claim an OpenAI first-wins rule.

This proxy does not advertise support for embeddings, moderations, audio speech or translations, image variations, or Responses storage routes.
