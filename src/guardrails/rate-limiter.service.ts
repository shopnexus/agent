import { Injectable } from '@nestjs/common';

interface RateLimitRecord {
  timestamps: number[];
}

@Injectable()
export class RateLimiterService {
  private readonly records = new Map<string, RateLimitRecord>();
  private readonly WINDOW_MS = 60_000; // 1 minute
  private readonly MAX_PER_MINUTE = 30;

  /**
   * Check if request exceeds rate limit.
   * Returns { allowed: true } or { allowed: false, retryAfterMs: number }
   */
  consume(key: string, limit = this.MAX_PER_MINUTE): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    let record = this.records.get(key);
    if (!record) {
      record = { timestamps: [] };
      this.records.set(key, record);
    }

    // Clean up timestamps older than window
    record.timestamps = record.timestamps.filter(t => now - t < this.WINDOW_MS);

    if (record.timestamps.length >= limit) {
      const oldest = record.timestamps[0];
      const retryAfterMs = this.WINDOW_MS - (now - oldest);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    record.timestamps.push(now);
    return { allowed: true };
  }
}
