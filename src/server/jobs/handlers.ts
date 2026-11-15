import { processWebhookEvent } from "../ingest/ingest.js";
import { analyzeConversation } from "../ai/conversationAnalysis.js";
import { runChatJob } from "../ai/employees.js";
import { sweepOrg, purgeExpired } from "./automation.js";
import type { JobHandler } from "./queue.js";

export const handlers: Record<string, JobHandler> = {
  process_webhook_event: (p) => processWebhookEvent(p.id),
  analyze_conversation: (p) => analyzeConversation(p),
  ai_chat: (p) => runChatJob(p),
  sweep_org: (p) => sweepOrg(p.orgId),
  purge_org: (p) => purgeExpired(p.orgId).then(() => undefined),
};
