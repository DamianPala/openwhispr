import type { ReasoningConfig } from "../BaseReasoningService";
import { getCloudModel, getLocalModel } from "../../models/ModelRegistry";
import { detectEndpointDialect, suppressThinking } from "./thinkingSuppressionDialects";
import { getModelFamilyConstraints } from "./modelFamilyConstraints";
import { matchesHost } from "../../utils/urlUtils";

// OpenRouter set up as a Custom endpoint (e.g. eu.openrouter.ai) keeps the
// generic shape, which works for most models. A family without an off switch
// gets the flat "none" refused upstream, so it needs OpenRouter's own
// reasoning object with the family's lowest effort.
function needsOpenRouterDialect(model: string, baseUrl?: string): boolean {
  const floor = getModelFamilyConstraints(model)?.reasoningEffort?.suppressValue;
  return !!floor && floor !== "none" && matchesHost(baseUrl, "openrouter.ai");
}

export function applyThinkingSuppression(
  requestBody: Record<string, unknown>,
  model: string,
  provider: string,
  config: ReasoningConfig,
  baseUrl?: string
): void {
  // A known endpoint host wins over the generic provider dialect.
  const providerKey =
    detectEndpointDialect(baseUrl)?.key ??
    (needsOpenRouterDialect(model, baseUrl) ? "openrouter" : provider.toLowerCase());
  const cloudModel = getCloudModel(model);

  // A registry model flagged disableThinking is force-suppressed on every
  // provider — scoping this to one provider is the #1611 bug pattern.
  if (cloudModel?.disableThinking) {
    suppressThinking(requestBody, providerKey, model);
    return;
  }

  if (config.disableThinking !== true) return;

  const localModel = getLocalModel(model);
  const knownModel = cloudModel || localModel;
  if (knownModel && !knownModel.supportsThinking) return;

  suppressThinking(requestBody, providerKey, model);
}
