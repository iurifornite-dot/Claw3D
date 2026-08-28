export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
};

export const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts) break;
      await wait(options.baseDelayMs * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Operation failed after retries.");
};

export class MinuteRateLimiter {
  private readonly maxEventsPerMinute: number;

  private readonly eventTimes: number[] = [];

  constructor(maxEventsPerMinute: number) {
    this.maxEventsPerMinute = Math.max(1, Math.floor(maxEventsPerMinute));
  }

  allow(now = Date.now()): boolean {
    const oneMinuteAgo = now - 60_000;
    while (this.eventTimes.length > 0 && this.eventTimes[0] < oneMinuteAgo) {
      this.eventTimes.shift();
    }
    if (this.eventTimes.length >= this.maxEventsPerMinute) {
      return false;
    }
    this.eventTimes.push(now);
    return true;
  }
}
