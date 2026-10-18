import type { Message, NewDelivery, Store, Task } from "../db/types.js";
import { previewText } from "./sign.js";

export async function planDeliveries(input: {
  store: Store;
  message: Message;
  tasks: Task[];
  ownerName: string;
  ownerNotifyUrl?: string;
}): Promise<NewDelivery[]> {
  if (input.message.metadata.kind === "task_status") return [];
  const rows: NewDelivery[] = [];
  if (input.message.toAgent && input.message.toAgent !== input.message.fromAgent) {
    const hook = await input.store.getWebhook(input.message.toAgent);
    if (hook) {
      rows.push({
        agentId: input.message.toAgent,
        event: "dm",
        targetId: input.message.id,
        payload: payload("dm", input.message.toName ?? "agent", input.message, null),
      });
    }
  }
  const decision = input.message.metadata.kind === "plan_decision";
  for (const task of input.tasks) {
    if (task.assigneeId === input.message.fromAgent) continue;
    const hook = await input.store.getWebhook(task.assigneeId);
    if (hook) {
      rows.push({
        agentId: task.assigneeId,
        event: "mention",
        targetId: decision ? input.message.id : task.id,
        payload: payload("mention", task.assigneeName, input.message, decision ? null : task.id),
      });
    }
    if (
      input.ownerNotifyUrl &&
      task.assigneeName === input.ownerName &&
      !task.creatorIsHuman
    ) {
      const owner = await input.store.getAgentByName(input.ownerName);
      if (owner && !owner.revokedAt) {
        rows.push({
          agentId: owner.id,
          event: "owner_notify",
          targetId: task.id,
          payload: payload("owner_notify", owner.name, input.message, task.id),
        });
      }
    }
  }
  const kind = input.message.metadata.kind;
  if (input.ownerNotifyUrl && (kind === "plan" || kind === "result")) {
    const owner = await input.store.getAgentByName(input.ownerName);
    if (owner && !owner.revokedAt && owner.id !== input.message.fromAgent) {
      rows.push({
        agentId: owner.id,
        event: "owner_notify",
        targetId: input.message.id,
        payload: payload("owner_notify", owner.name, input.message, null),
      });
    }
  }
  return rows;
}

function payload(event: string, agent: string, message: Message, taskId: string | null): Record<string, unknown> {
  return {
    event,
    agent,
    from: message.fromName,
    messageId: message.id,
    taskId,
    room: message.roomName,
    threadId: message.threadId,
    preview: previewText(message.body),
    createdAt: message.createdAt,
  };
}
