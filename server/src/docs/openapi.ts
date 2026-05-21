export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'FreeLLMAPI',
    version: '0.1.0',
    description: 'OpenAI-compatible and Anthropic-compatible routing proxy.',
  },
  paths: {
    '/v1/chat/completions': {
      post: {
        summary: 'Create an OpenAI-compatible chat completion',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['messages'],
                properties: {
                  model: { type: 'string', description: 'Omit or use auto to let the router pick.' },
                  messages: { type: 'array', items: { type: 'object' } },
                  max_tokens: { type: 'integer' },
                  temperature: { type: 'number' },
                  stream: { type: 'boolean' },
                  tools: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OpenAI-compatible chat completion or SSE stream.' },
          '400': { description: 'Invalid request.' },
          '429': { description: 'All available models are exhausted.' },
          '502': { description: 'Upstream provider error.' },
        },
      },
    },
    '/v1/messages': {
      get: {
        summary: 'Validate Anthropic-compatible gateway token',
        description: 'Returns 200 when the unified API key is valid. Claude Office add-ins use this before model discovery.',
        security: [{ anthropicKey: [] }],
        responses: {
          '200': { description: 'Gateway token is valid.' },
          '401': { description: 'Invalid API key.' },
        },
      },
      post: {
        summary: 'Create an Anthropic-compatible message',
        description: 'Accepts Anthropic Messages API requests for clients such as Claude in Excel. The model field is treated as a facade; routing still falls back through the configured provider chain.',
        security: [{ anthropicKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                  model: { type: 'string', example: 'claude-opus-4-7' },
                  max_tokens: { type: 'integer', example: 1024 },
                  system: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
                  messages: { type: 'array', items: { type: 'object' } },
                  stream: { type: 'boolean' },
                  tools: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Anthropic-compatible message object or Anthropic SSE stream.' },
          '400': { description: 'Invalid request.' },
          '429': { description: 'All available models are exhausted.' },
          '502': { description: 'Upstream provider error.' },
        },
      },
    },
    '/v1/models': {
      get: {
        summary: 'List models',
        description: 'Returns OpenAI model list by default. If anthropic-version or x-api-key is present, returns Anthropic model-list shape.',
        responses: {
          '200': { description: 'Model list.' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
      },
      anthropicKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
  },
};
