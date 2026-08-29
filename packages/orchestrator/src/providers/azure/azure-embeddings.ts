/**
 * Azure OpenAI-backed `EmbeddingProvider` (text-embedding-3-large, PRD
 * decision 4's dedicated embedding deployment).
 */
import { AzureOpenAI } from 'openai';
import { getBearerTokenProvider } from '@azure/identity';
import type { TrialPulseConfig } from '../../config';
import type { EmbeddingProvider, EmbeddingResult } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

// Cognitive Services token scope required for Azure AD auth to Azure OpenAI.
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';

function createClient(config: TrialPulseConfig): AzureOpenAI {
  const common = {
    endpoint: config.azureOpenAI.endpoint,
    apiVersion: config.azureOpenAI.apiVersion,
    deployment: config.azureOpenAI.embeddingDeployment,
  };
  if (config.azureOpenAI.apiKey) {
    return new AzureOpenAI({ ...common, apiKey: config.azureOpenAI.apiKey });
  }
  return new AzureOpenAI({
    ...common,
    azureADTokenProvider: getBearerTokenProvider(getManagedIdentityCredential(), COGNITIVE_SERVICES_SCOPE),
  });
}

class AzureEmbeddingProvider implements EmbeddingProvider {
  private readonly client: AzureOpenAI;
  private readonly deployment: string;

  constructor(config: TrialPulseConfig) {
    this.client = createClient(config);
    this.deployment = config.azureOpenAI.embeddingDeployment;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await withRetry(
      () => this.client.embeddings.create({ model: this.deployment, input: text }),
      { isRetryable: isLikelyTransientAzureError },
    );
    const vector = response.data[0]?.embedding;
    if (!vector) {
      throw new Error('Azure OpenAI embeddings response contained no vector.');
    }
    return {
      vector,
      tokens: response.usage.total_tokens,
      model: response.model,
    };
  }
}

export function createAzureEmbeddingProvider(config: TrialPulseConfig): EmbeddingProvider {
  return new AzureEmbeddingProvider(config);
}
