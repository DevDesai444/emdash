// Small timing helpers. Samples are milliseconds; percentiles from the sorted
// array are good enough at bench sample sizes — no need for HDR histograms.

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export async function timed<T>(samples: number[], fn: () => Promise<T>): Promise<T> {
  const t0 = nowMs();
  const out = await fn();
  samples.push(nowMs() - t0);
  return out;
}

export interface Summary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    meanMs: round(sorted.length ? sum / sorted.length : 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(percentile(sorted, 100)),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtSummary(label: string, s: Summary): string {
  return `${label.padEnd(24)} n=${String(s.count).padEnd(5)} mean=${s.meanMs}ms p50=${s.p50Ms}ms p95=${s.p95Ms}ms p99=${s.p99Ms}ms max=${s.maxMs}ms`;
}

// Run `worker` over `items` with at most `concurrency` in flight. Errors don't
// abort the pool — they come back in the results so scenarios can count
// failure classes.
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: Error }> = new Array(
    items.length
  );
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: error as Error };
      }
    }
  }
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => lane());
  await Promise.all(lanes);
  return results;
}

export function emitResult(payload: Record<string, unknown>): void {
  // single line the launcher greps out of stdout
  console.log(`@@RESULT ${JSON.stringify(payload)}`);
}
