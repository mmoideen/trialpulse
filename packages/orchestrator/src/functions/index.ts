/**
 * Azure Functions v4 programming model entry point. Registers every HTTP
 * function and timer against the real `@azure/functions` `app` singleton,
 * wired to Azure-backed (or memory-backed, per `TRIALPULSE_PROVIDER_MODE`)
 * providers.
 *
 * This module has import-time side effects (function registration) and is
 * therefore never imported by unit tests -- they import each
 * `handle*`/`register*` function directly with a hand-built `AppDeps`.
 */
import { registerAdminReindexFunction } from './admin-reindex';
import { registerAdminUsageFunction } from './admin-usage';
import { registerConversationsFunction } from './conversations';
import { createAppDeps } from './deps';
import { registerDocumentsFunction } from './documents';
import { registerFeedbackFunction } from './feedback';
import { registerHealthFunction } from './health';
import { registerTeamsMessagesFunction } from './messages';
import { registerQueryFunction } from './query';
import { registerCostAlertTimer, registerDailyAuditCompactionTimer, registerSharePointDeltaSyncTimer } from './timers';
import { registerSharePointWebhookFunction } from './webhooks-sharepoint';

const deps = createAppDeps();

registerQueryFunction(deps);
registerHealthFunction(deps);
registerAdminUsageFunction(deps);
registerAdminReindexFunction(deps);
registerDocumentsFunction(deps);
registerConversationsFunction(deps);
registerFeedbackFunction(deps);
registerSharePointWebhookFunction(deps);
registerTeamsMessagesFunction(deps);

registerDailyAuditCompactionTimer(deps);
registerCostAlertTimer(deps);
registerSharePointDeltaSyncTimer(deps);
