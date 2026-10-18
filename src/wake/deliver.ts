import type { Delivery, Store } from "../db/types.js";
import { signPayload } from "./sign.js";

const MAX_ATTEMPTS = 6;
const PASSES = 3;

export type DispatchOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  ownerNotifyUrl?: string;
  ownerNotifySecret?: string;
};

export async function dispatchDue(store: Store, options: DispatchOptions = {}): Promise<{ delivered: number; failed: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let delivered = 0;
  let failed = 0;
  for (let pass = 0; pass < PASSES; pass += 1) {
    const due = await store.claimDueDeliveries(now().toISOString(), 20, MAX_ATTEMPTS);
    if (due.length === 0) break;
    for (const row of due) {
      const ok = await postDelivery(store, row, fetchImpl, now(), options);
      if (ok) delivered += 1;
      else failed += 1;
    }
    if (pass < PASSES - 1) await sleep(200 * (pass + 1));
  }
  return { delivered, failed };
}

async function postDelivery(
  store: Store,
  row: Delivery,
  fetchImpl: typeof fetch,
  now: Date,
  options: DispatchOptions,
): Promise<boolean> {
  const target = await targetFor(store, row, options);
  const body = JSON.stringify(row.payload);
  if (!target) {
    await store.finishDelivery(row.id, {
      status: "failed",
      error: "No wake-up URL is configured.",
      nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    return false;
  }
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = signPayload(target.secret, timestamp, body);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "agent-bus-wake/1",
        "x-agent-bus-timestamp": timestamp,
        "x-agent-bus-signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) {
      await store.finishDelivery(row.id, {
        status: "delivered",
        error: null,
        nextAttemptAt: now.toISOString(),
      });
      return true;
    }
    await fail(store, row, now, `HTTP ${response.status}`);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "fetch failed";
    await fail(store, row, now, message);
    return false;
  }
}

async function fail(store: Store, row: Delivery, now: Date, error: string): Promise<void> {
  const immediate = row.attempts < PASSES;
  const delay = immediate ? 0 : Math.min(60_000 * row.attempts, 60 * 60 * 1000);
  await store.finishDelivery(row.id, {
    status: "failed",
    error: error.slice(0, 500),
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
  });
}

async function targetFor(
  store: Store,
  row: Delivery,
  options: DispatchOptions,
): Promise<{ url: string; secret: string } | null> {
  if (row.event === "owner_notify") {
    if (!options.ownerNotifyUrl) return null;
    return { url: options.ownerNotifyUrl, secret: options.ownerNotifySecret ?? "" };
  }
  const hook = await store.getWebhook(row.agentId);
  return hook ? { url: hook.url, secret: hook.secret } : null;
}
