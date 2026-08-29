/**
 * Azure OpenAI-backed `GenerationProvider`.
 *
 * `request.model` here is a *deployment name* (either the gpt-4o or
 * gpt-4o-mini deployment, chosen upstream by `model-router.ts`), so this
 * provider constructs a small per-deployment client cache rather than
 * pinning one deployment at construction time -- the circuit breaker and
 * the router both need to call whichever deployment they choose for a given
 * request.
 */
import { AzureOpenAI } from 'openai';
import { getBearerTokenProvider } from '@azure/identity';
import type { TrialPulseConfig } from '../../config';
import type { GenerationProvider, GenerationRequest, GenerationResult } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';
const DEFAULT_MAX_OUTPUT_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0.1; // Low temperature: grounded, citation-accurate answers over creative ones.

class AzureGenerationProvider implements GenerationProvider {
  private readonly clientsByDeployment = new Map<string, AzureOpenAI>();

  constructor(private readonly config: TrialPulseConfig) {}

  private clientFor(deployment: string): AzureOpenAI {
    const cached = this.clientsByDeployment.get(deployment);
    if (cached) return cached;

    const common = {
      endpoint: this.config.azureOpenAI.endpoint,
      apiVersion: this.config.azureOpenAI.apiVersion,
      deployment,
    };
    const client = this.config.azureOpenAI.apiKey
      ? new AzureOpenAI({ ...common, apiKey: this.config.azureOpenAI.apiKey })
      : new AzureOpenAI({
          ...common,
          azureADTokenProvider: getBearerTokenProvider(getManagedIdentityCredential(), COGNITIVE_SERVICES_SCOPE),
        });
    this.clientsByDeployment.set(deployment, client);
    return client;
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const client = this.clientFor(request.model);
    const response = await withRetry(
      () =>
        client.chat.completions.create({
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        }),
      { isRetryable: isLikelyTransientAzureError },
    );

    const text = response.choices[0]?.message?.content ?? '';
    return {
      text,
      tokensInput: response.usage?.prompt_tokens ?? 0,
      tokensOutput: response.usage?.completion_tokens ?? 0,
      model: response.model,
    };
  }
}

export function createAzureGenerationProvider(config: TrialPulseConfig): GenerationProvider {
  return new AzureGenerationProvider(config);
}
