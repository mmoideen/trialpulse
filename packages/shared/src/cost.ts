/** Token pricing and cost estimation for Azure OpenAI deployments. */

export type GenerationModel = 'gpt-4o' | 'gpt-4o-mini';
export type EmbeddingModel = 'text-embedding-3-large';
export type ModelName = GenerationModel | EmbeddingModel;

/** USD per 1,000 tokens. Update alongside the Azure OpenAI price list. */
export interface ModelPricing {
  inputPer1k: number;
  outputPer1k: number;
}

export const MODEL_PRICING: Readonly<Record<ModelName, ModelPricing>> = Object.freeze({
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'text-embedding-3-large': { inputPer1k: 0.00013, outputPer1k: 0 },
});

export function isKnownModel(model: string): model is ModelName {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICING, model);
}

/**
 * Estimate the USD cost of a single model call.
 * Unknown models cost 0 rather than throwing: a pricing gap must never take
 * down a user query, but it is surfaced through `isKnownModel` at startup.
 */
export function estimateCost(
  model: string,
  tokensInput: number,
  tokensOutput: number,
): number {
  if (!isKnownModel(model)) return 0;
  const pricing = MODEL_PRICING[model];
  const cost =
    (tokensInput / 1000) * pricing.inputPer1k +
    (tokensOutput / 1000) * pricing.outputPer1k;
  // Round to 6 dp: sub-micro-dollar precision is noise and breaks float sums.
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Rough token estimate used for routing decisions and pre-flight budgeting.
 * ~4 characters per token is the standard approximation for English clinical
 * prose. Actual billing always uses the usage numbers returned by the API.
 */
export function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
