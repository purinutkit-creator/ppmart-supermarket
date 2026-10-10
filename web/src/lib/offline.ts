// Offline support: catalog cache + outbox of sales waiting to sync (IndexedDB).
import { get as idbGet, set as idbSet, createStore } from 'idb-keyval';
import { api, ApiError } from './api';

const store = createStore('ppmart-pos', 'kv');

export interface OutboxEntry {
  key: string; // idempotency key
  payload: any;
  receipt: any; // locally-built receipt (printed at the till)
  createdAt: string;
  attempts: number;
  lastError?: string;
  needsAttention?: boolean;
}

export async function cacheCatalog(c: any) { await idbSet('catalog', c, store); }
export async function cachedCatalog(): Promise<any | null> { return (await idbGet('catalog', store)) ?? null; }

export async function getOutbox(): Promise<OutboxEntry[]> { return (await idbGet('outbox', store)) ?? []; }
async function saveOutbox(o: OutboxEntry[]) { await idbSet('outbox', o, store); window.dispatchEvent(new Event('ppmart-outbox')); }
export async function addToOutbox(e: OutboxEntry) { const o = await getOutbox(); o.push(e); await saveOutbox(o); }

let syncing = false;
/** Push queued offline sales. Idempotency keys make retries safe (no duplicate sales). */
export async function syncOutbox(): Promise<{ synced: number; failed: number }> {
  if (syncing) return { synced: 0, failed: 0 };
  syncing = true;
  let synced = 0, failed = 0;
  try {
    const list = await getOutbox();
    const keep: OutboxEntry[] = [];
    for (const e of list) {
      try {
        await api('/api/pos/checkout', { body: e.payload, timeoutMs: 30000 });
        synced++;
      } catch (err) {
        const ae = err as ApiError;
        e.attempts++;
        e.lastError = ae.message;
        if (ae.status >= 400 && ae.status < 500 && ae.status !== 401 && ae.status !== 408 && ae.code !== 'BILL_NO_TAKEN') e.needsAttention = true;
        keep.push(e);
        failed++;
        if (ae.status === 0) { keep.push(...list.slice(list.indexOf(e) + 1)); break; }
      }
    }
    await saveOutbox(keep);
  } finally { syncing = false; }
  return { synced, failed };
}

export async function removeFromOutbox(key: string) { await saveOutbox((await getOutbox()).filter((e) => e.key !== key)); }

// ---- per-terminal bill numbering (works offline) ----
export async function nextBillNo(terminalCode: string, serverLastSeq: number | null): Promise<string> {
  const k = 'billseq:' + terminalCode;
  const local = (await idbGet<number>(k, store)) ?? 0;
  const seq = Math.max(local, serverLastSeq ?? 0) + 1;
  await idbSet(k, seq, store);
  return `${terminalCode}-${String(seq).padStart(6, '0')}`;
}

/** Keep the local counter at least at the server's last sequence (called whenever we are online). */
export async function primeBillSeq(terminalCode: string, serverLastSeq: number) {
  const k = 'billseq:' + terminalCode;
  const local = (await idbGet<number>(k, store)) ?? 0;
  if (serverLastSeq > local) await idbSet(k, serverLastSeq, store);
}
