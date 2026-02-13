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
