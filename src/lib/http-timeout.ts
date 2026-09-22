/**
 * Default timeout (ms) for outbound HTTP calls to third parties
 * (webhooks, OAuth userinfo, Turnstile verification).
 * Prevents a slow/unresponsive upstream from holding a worker indefinitely.
 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS) || 10_000;

/**
 * Return a fetch() options object carrying an AbortSignal timeout.
 * Merges with any caller-supplied options; the timeout signal wins over a
 * caller-provided signal (we own the abort policy for outbound calls).
 */
export function fetchTimeoutOptions(
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_OUTBOUND_TIMEOUT_MS,
): RequestInit {
  return {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  };
}
