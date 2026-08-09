const DEFAULT_PROXY_URL = 'http://127.0.0.1:8045';

export const CANDIDATE_BODIES = Object.freeze({
  generateChat: {
    project: 'projects/<project-number>',
    requestId: 'probe-generate-chat',
    userMessage: 'Reply with OK.',
  },
  streamGenerateChat: {
    project: 'projects/<project-number>',
    requestId: 'probe-stream-generate-chat',
    userMessage: 'Reply with OK.',
  },
  tabChat: {
    project: 'projects/<project-number>',
    request: {},
  },
  completeCode: {
    project: 'projects/<project-number>',
    requestId: 'probe-complete-code',
    ideContext: {},
    userContext: {},
  },
  generateCode: {
    project: 'projects/<project-number>',
    requestId: 'probe-generate-code',
    ideContext: {},
  },
  transformCode: {
    project: 'projects/<project-number>',
    requestId: 'probe-transform-code',
    ideContext: {},
    userPrompt: 'Reply with OK.',
    command: 'GENERATE',
  },
  internalAtomicAgenticChat: {
    project: 'projects/<project-number>',
    requestId: 'probe-atomic-agentic-chat',
    userMessage: 'Reply with OK.',
  },
  listModelConfigs: {
    domain: 'DOMAIN_STREAMING_CHAT',
  },
});

function usage() {
  const verbs = Object.keys(CANDIDATE_BODIES).join(', ');
  return [
    'Usage: AGM_PROXY_API_KEY=<key> node scripts/probe-v1internal-shapes.mjs <verb> [body-json]',
    '',
    `Known verbs with descriptor-derived defaults: ${verbs}`,
    'Set AGM_PROXY_URL to override the default http://127.0.0.1:8045 proxy URL.',
    'The proxy must have AGM_V1INTERNAL_PASSTHROUGH=1 when it starts.',
  ].join('\n');
}

function readBody(verb, bodyArgument) {
  if (!bodyArgument) {
    const defaultBody = CANDIDATE_BODIES[verb];

    if (!defaultBody) {
      throw new Error(`No default body is known for ${verb}. Pass body-json explicitly.`);
    }

    return defaultBody;
  }

  try {
    return JSON.parse(bodyArgument);
  } catch {
    throw new Error('body-json must be valid JSON.');
  }
}

async function main() {
  const [verb, bodyArgument] = process.argv.slice(2);

  if (!verb || process.argv.length > 4) {
    throw new Error(usage());
  }

  const apiKey = process.env.AGM_PROXY_API_KEY;

  if (!apiKey) {
    throw new Error('AGM_PROXY_API_KEY is required.');
  }

  const body = readBody(verb, bodyArgument);
  const proxyUrl = process.env.AGM_PROXY_URL ?? DEFAULT_PROXY_URL;
  const response = await fetch(`${proxyUrl.replace(/\/$/u, '')}/v1internal/${verb}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  process.stdout.write(`Status: ${response.status} ${response.statusText}\n`);
  process.stdout.write(`${await response.text()}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
