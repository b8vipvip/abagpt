import { once } from "node:events";
import type { FastifyReply } from "fastify";

const DEFAULT_STALL_TIMEOUT_MS = 15_000;

export interface SseWriterOptions {
  /** Shorter values are useful for deterministic tests; production uses 15 seconds. */
  stallTimeoutMs?: number;
}

/**
 * Serializes SSE frames and propagates socket backpressure to the upstream
 * event reader. A false return from ServerResponse.write() is not a failure:
 * the next frame waits for "drain". A client that never drains is disconnected
 * after a bounded stall interval so the conversation lock cannot be held
 * forever.
 */
export class SseWriter {
  private readonly closeController = new AbortController();
  private readonly stallTimeoutMs: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly reply: FastifyReply,
    options: SseWriterOptions = {},
  ) {
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.reply.raw.once("close", () => {
      if (!this.reply.raw.writableEnded) {
        this.closeController.abort(new DOMException("SSE client disconnected", "AbortError"));
      }
    });
  }

  write(data: unknown, eventType?: string): Promise<void> {
    const eventLine = eventType ? "event: " + eventType + "\n" : "";
    const dataLine = "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\n\n";
    return this.enqueue(eventLine + dataLine);
  }

  comment(value: string): Promise<void> {
    return this.enqueue(": " + value + "\n\n");
  }

  flush(): Promise<void> {
    return this.tail;
  }

  async end(): Promise<void> {
    await this.flush();
    if (!this.reply.raw.destroyed && !this.reply.raw.writableEnded) {
      this.reply.raw.end();
    }
  }

  private enqueue(frame: string): Promise<void> {
    // A transient write error must not poison the queue: the route may still
    // be able to send a sanitized terminal error frame. A destroyed/closed
    // socket is rejected by writeFrame before another write is attempted.
    const next = this.tail.catch(() => undefined).then(() => this.writeFrame(frame));
    this.tail = next;
    return next;
  }

  private async writeFrame(frame: string): Promise<void> {
    const raw = this.reply.raw;
    this.closeController.signal.throwIfAborted();
    if (raw.destroyed || raw.writableEnded) {
      throw new DOMException("SSE response is already closed", "AbortError");
    }

    if (raw.write(frame)) return;

    const timeoutSignal = AbortSignal.timeout(this.stallTimeoutMs);
    const waitSignal = AbortSignal.any([this.closeController.signal, timeoutSignal]);
    try {
      await once(raw, "drain", { signal: waitSignal });
    } catch (error) {
      if (timeoutSignal.aborted && !this.closeController.signal.aborted) {
        raw.destroy();
        throw new Error("响应客户端读取过慢。", { cause: error });
      }
      throw error;
    }
    this.closeController.signal.throwIfAborted();
    if (raw.destroyed || raw.writableEnded) {
      throw new DOMException("SSE response closed before drain", "AbortError");
    }
  }
}
