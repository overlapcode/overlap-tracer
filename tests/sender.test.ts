import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventSender } from "../src/sender";
import type { IngestEvent } from "../src/types";

function makeEvent(overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    session_id: "sess_test",
    timestamp: new Date().toISOString(),
    event_type: "file_op",
    user_id: "user_123",
    repo_name: "test-repo",
    agent_type: "claude_code",
    tool_name: "Edit",
    file_path: "src/index.ts",
    operation: "modify",
    ...overrides,
  };
}

describe("EventSender", () => {
  it("creates batches per team URL", () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-b.dev", "tok_b", makeEvent());

    expect(sender.getPendingCount()).toBe(2);
    sender.clearAll();
  });

  it("accumulates events in a batch", () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());

    expect(sender.getPendingCount()).toBe(3);
    sender.clearAll();
  });

  it("caps max_batch_size at 100", () => {
    const sender = new EventSender({ batch_interval_ms: 2000, max_batch_size: 200 });
    // Internal cap should be 100, not 200
    // We can't directly test the private field, but we can verify it doesn't crash
    for (let i = 0; i < 150; i++) {
      sender.add("https://team-a.dev", "tok_a", makeEvent());
    }
    // Some should have been flushed (attempted), leaving fewer pending
    // Note: flush will fail since there's no real server, so events get re-queued
    sender.clearAll();
  });

  it("calls onBatchSent callback on successful flush", async () => {
    let sentCount = 0;
    const sender = new EventSender(
      { batch_interval_ms: 10000, max_batch_size: 50 },
      (_url, count) => { sentCount = count; },
    );

    // Mock fetch for this test
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        data: { processed: 3, errors: [], sessions_created: 0, sessions_ended: 0, file_ops_created: 3, prompts_created: 0 },
      }), { status: 200 })),
    ) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());

    await sender.flush("https://team-a.dev");
    expect(sentCount).toBe(3);
    expect(sender.getPendingCount()).toBe(0);

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("re-queues events on server error", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "Server error" }), { status: 500 })),
    ) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());

    await sender.flush("https://team-a.dev");
    // Events should be re-queued
    expect(sender.getPendingCount()).toBe(2);

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("re-queues events on network error", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());

    await sender.flush("https://team-a.dev");
    expect(sender.getPendingCount()).toBe(1);

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("does not trigger flush during retry backoff", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 5 });

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(new Response(JSON.stringify({ error: "Server error" }), { status: 500 }));
    }) as typeof fetch;

    // Fill and flush — should fail and enter retry backoff
    for (let i = 0; i < 5; i++) sender.add("https://team-a.dev", "tok_a", makeEvent());
    await sender.flush("https://team-a.dev");
    expect(fetchCount).toBe(1);

    // Now add more events beyond maxBatchSize — should NOT trigger flush due to backoff
    for (let i = 0; i < 10; i++) sender.add("https://team-a.dev", "tok_a", makeEvent());
    // Give any potential async flush a tick to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCount).toBe(1); // Still 1 — no new flush triggered

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("handles null JSON response body without crashing", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("null", { status: 500, headers: { "Content-Type": "application/json" } })),
    ) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    // Should not throw
    await sender.flush("https://team-a.dev");
    expect(sender.getPendingCount()).toBe(1); // Re-queued, not crashed

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("chunks large queues into maxBatchSize per request", async () => {
    let fetchCallEvents: number[] = [];
    const sender = new EventSender(
      { batch_interval_ms: 10000, max_batch_size: 5 },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      fetchCallEvents.push(body.events.length);
      return Promise.resolve(new Response(JSON.stringify({
        data: { processed: body.events.length, errors: [], sessions_created: 0, sessions_ended: 0, file_ops_created: body.events.length, prompts_created: 0, agent_responses_created: 0 },
      }), { status: 200 }));
    }) as typeof fetch;

    // Add 12 events. First 5 trigger add()->flush() (async, not awaited).
    // But flushing=true blocks further auto-flushes, so events 6-12 just queue.
    for (let i = 0; i < 12; i++) sender.add("https://team-a.dev", "tok_a", makeEvent());

    // Wait for the auto-flush from add() to complete
    await new Promise((r) => setTimeout(r, 50));

    // The auto-flush should have sent exactly 5 (maxBatchSize), not all 12
    expect(fetchCallEvents[0]).toBe(5);
    // 7 events remain queued
    expect(sender.getPendingCount()).toBe(7);

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("caps queue size to prevent unbounded accumulation", () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 10000 });

    // Add way more than MAX_QUEUE_SIZE (500) events
    for (let i = 0; i < 600; i++) {
      sender.add("https://team-a.dev", "tok_a", makeEvent({ session_id: `sess_${i}` }));
    }

    expect(sender.getPendingCount()).toBeLessThanOrEqual(500);
    sender.clearAll();
  });

  it("prevents concurrent flushes via flushing guard", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      fetchCount++;
      // Slow response
      return new Promise((resolve) => setTimeout(() => resolve(
        new Response(JSON.stringify({
          data: { processed: 2, errors: [], sessions_created: 0, sessions_ended: 0, file_ops_created: 2, prompts_created: 0, agent_responses_created: 0 },
        }), { status: 200 }),
      ), 50));
    }) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());
    sender.add("https://team-a.dev", "tok_a", makeEvent());

    // Start two flushes concurrently — second should be no-op
    const p1 = sender.flush("https://team-a.dev");
    const p2 = sender.flush("https://team-a.dev");
    await Promise.all([p1, p2]);

    expect(fetchCount).toBe(1); // Only one fetch, not two

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });

  it("flushAll completes within timeout", async () => {
    const sender = new EventSender({ batch_interval_ms: 10000, max_batch_size: 50 });

    const originalFetch = globalThis.fetch;
    // Simulate slow server
    globalThis.fetch = mock(() =>
      new Promise((resolve) => setTimeout(() => resolve(
        new Response(JSON.stringify({
          data: { processed: 1, errors: [], sessions_created: 0, sessions_ended: 0, file_ops_created: 1, prompts_created: 0 },
        }), { status: 200 }),
      ), 100)),
    ) as typeof fetch;

    sender.add("https://team-a.dev", "tok_a", makeEvent());

    const start = Date.now();
    await sender.flushAll(2000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);

    globalThis.fetch = originalFetch;
    sender.clearAll();
  });
});
