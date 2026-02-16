import type { IngestEvent } from "./types";

type PendingBatch = {
  teamUrl: string;
  token: string;
  events: IngestEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

type IngestResponseData = {
  processed: number;
  errors: string[];
  sessions_created: number;
  sessions_ended: number;
  file_ops_created: number;
  prompts_created: number;
  agent_responses_created: number;
};

const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RETRIES = 5;

export class EventSender {
  private batches = new Map<string, PendingBatch>();
  private batchIntervalMs: number;
  private maxBatchSize: number;
  private onBatchSent?: (teamUrl: string, count: number) => void;
  private onAuthFailure?: (teamUrl: string) => void;
  private suspendedTeams = new Set<string>();
  private warnedTeams = new Set<string>();

  constructor(
    config: { batch_interval_ms: number; max_batch_size: number },
    onBatchSent?: (teamUrl: string, count: number) => void,
  ) {
    this.batchIntervalMs = config.batch_interval_ms;
    this.maxBatchSize = Math.min(config.max_batch_size, 100);
    this.onBatchSent = onBatchSent;
  }

  setOnAuthFailure(callback: (teamUrl: string) => void): void {
    this.onAuthFailure = callback;
  }

  isTeamSuspended(teamUrl: string): boolean {
    return this.suspendedTeams.has(teamUrl);
  }

  suspendTeam(teamUrl: string): void {
    this.suspendedTeams.add(teamUrl);
    // Clear any pending events for this team
    const batch = this.batches.get(teamUrl);
    if (batch) {
      if (batch.timer) clearTimeout(batch.timer);
      if (batch.retryTimer) clearTimeout(batch.retryTimer);
      this.batches.delete(teamUrl);
    }
  }

  unsuspendTeam(teamUrl: string): void {
    this.suspendedTeams.delete(teamUrl);
    this.warnedTeams.delete(teamUrl);
  }

  add(teamUrl: string, token: string, event: IngestEvent): void {
    // Skip silently if team is suspended (401'd)
    if (this.suspendedTeams.has(teamUrl)) return;

    let batch = this.batches.get(teamUrl);
    if (!batch) {
      batch = { teamUrl, token, events: [], timer: null, retryCount: 0, retryTimer: null };
      this.batches.set(teamUrl, batch);
    }

    batch.events.push(event);

    if (batch.events.length >= this.maxBatchSize) {
      this.flush(teamUrl);
      return;
    }

    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(teamUrl), this.batchIntervalMs);
    }
  }

  async flush(teamUrl: string): Promise<void> {
    const batch = this.batches.get(teamUrl);
    if (!batch || batch.events.length === 0) return;

    const events = [...batch.events];
    batch.events = [];
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    try {
      const res = await fetch(`${teamUrl}/api/v1/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${batch.token}`,
        },
        body: JSON.stringify({ events }),
      });

      if (res.status === 401) {
        // Auth failure — suspend this team, don't retry
        if (!this.warnedTeams.has(teamUrl)) {
          console.warn(`[${teamUrl}] Token rejected (401). Suspending sends until token is updated.`);
          this.warnedTeams.add(teamUrl);
        }
        this.suspendTeam(teamUrl);
        this.onAuthFailure?.(teamUrl);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const errMsg = (body as Record<string, unknown>).error || `HTTP ${res.status}`;
        console.error(`[${teamUrl}] Ingest failed: ${errMsg}`);
        this.requeueWithBackoff(batch, events);
      } else {
        const body = (await res.json()) as { data: IngestResponseData };
        const { processed, errors } = body.data;
        batch.retryCount = 0; // Reset on success
        this.onBatchSent?.(teamUrl, processed);
        if (errors.length > 0) {
          console.warn(`[${teamUrl}] Ingest partial: ${processed} ok, ${errors.length} errors`);
          for (const e of errors) {
            console.warn(`  → ${e}`);
          }
        }
      }
    } catch (err) {
      console.error(`[${teamUrl}] Ingest error: ${err}`);
      this.requeueWithBackoff(batch, events);
    }
  }

  private requeueWithBackoff(batch: PendingBatch, events: IngestEvent[]): void {
    batch.retryCount++;

    // Drop events after max retries to prevent infinite accumulation
    if (batch.retryCount > MAX_RETRIES) {
      console.warn(`[${batch.teamUrl}] Dropping ${events.length} events after ${MAX_RETRIES} retries`);
      batch.retryCount = 0;
      return;
    }

    // Put events back at the front
    batch.events = [...events, ...batch.events];

    const delay = Math.min(
      this.batchIntervalMs * Math.pow(2, batch.retryCount),
      MAX_RETRY_DELAY_MS,
    );

    if (batch.retryTimer) clearTimeout(batch.retryTimer);
    batch.retryTimer = setTimeout(() => {
      batch.retryTimer = null;
      this.flush(batch.teamUrl);
    }, delay);
  }

  async flushAll(timeoutMs: number = 5000): Promise<void> {
    // Clear all pending timers
    for (const batch of this.batches.values()) {
      if (batch.timer) {
        clearTimeout(batch.timer);
        batch.timer = null;
      }
      if (batch.retryTimer) {
        clearTimeout(batch.retryTimer);
        batch.retryTimer = null;
      }
    }

    const flushPromises = [...this.batches.keys()].map((url) => this.flush(url));
    await Promise.race([
      Promise.allSettled(flushPromises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  clearAll(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
      if (batch.retryTimer) clearTimeout(batch.retryTimer);
    }
    this.batches.clear();
  }

  getPendingCount(): number {
    let count = 0;
    for (const batch of this.batches.values()) {
      count += batch.events.length;
    }
    return count;
  }
}
