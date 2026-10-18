import { AgentBus, type AfterMessage } from "../bus/service.js";
import type { AppConfig } from "../config.js";
import type { Store } from "../db/types.js";
import { dispatchDue } from "./deliver.js";
import { planDeliveries } from "./plan.js";
import { scheduleAfterResponse } from "./schedule.js";

export function wakeHook(store: Store, config: AppConfig, env: NodeJS.ProcessEnv): AfterMessage {
  return async (message, tasks) => {
    const rows = await planDeliveries({
      store,
      message,
      tasks,
      ownerName: config.ownerName,
      ownerNotifyUrl: env.OWNER_NOTIFY_URL,
    });
    if (rows.length === 0) return;
    await store.enqueueDeliveries(rows);
    scheduleAfterResponse(() =>
      dispatchDue(store, {
        ownerNotifyUrl: env.OWNER_NOTIFY_URL,
        ownerNotifySecret: env.OWNER_NOTIFY_SECRET,
      }),
    );
  };
}

export function createAgentBus(store: Store, config: AppConfig, env: NodeJS.ProcessEnv = {}): AgentBus {
  return new AgentBus(store, config, wakeHook(store, config, env));
}
