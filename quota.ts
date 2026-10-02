/**
 * Stop-error classification for pi-supervisor's quota wait.
 *
 * Pure and dependency-free so it can be unit-tested with `node --test quota.test.ts`.
 *
 * Three buckets, decided only from the assistant message's `errorMessage` text —
 * never from the provider id, so a model switch needs no code change:
 *
 *   quota      the account ran out of a metered allowance that resets with time.
 *              Waiting and re-probing is correct, and a failed probe costs 0 tokens.
 *   permanent  a human must act (money, credentials, region, model/config).
 *              Waiting would burn hours for nothing.
 *   other      transient or unrelated. pi's built-in auto-retry already owns these;
 *              the supervisor keeps its historical behavior and does not interfere.
 *
 * Rule order matters. `ignorePatterns` beats `extraPatterns` beats the built-ins, and
 * the throttle guard runs before the quota rules because real 429 bodies contain both
 * "429" and "limit" while meaning something entirely different (per-minute tpm/rpm
 * throttling, which recovers in seconds).
 */

export type StopErrorKind = "quota" | "permanent" | "other";

export interface ClassifyOptions {
  /** Extra regex sources (from config) that force a message into the `quota` bucket. */
  extraPatterns?: readonly string[];
  /** Regex sources (from config) that force a message out of every bucket into `other`. */
  ignorePatterns?: readonly string[];
}

export interface StopErrorClassification {
  kind: StopErrorKind;
  /** Short label of the rule that decided, for verdicts.jsonl. */
  rule?: string;
}

interface Rule {
  label: string;
  pattern: RegExp;
}

/**
 * Per-minute throttles that pi already retries. Guarded first so they can never be
 * mistaken for a metered allowance: `inference exceeds tpm/rpm limit` carries a 429
 * and the word "limit" but recovers in seconds, not hours.
 */
const TRANSIENT_GUARD: Rule[] = [
  { label: "transient-tpm-rpm", pattern: /tpm\/rpm|TpmRateLimit|RpmRateLimit/i },
];

/**
 * Needs money. Checked before the quota rules: `402 ... Insufficient account funds`
 * and `credit balance is too low` will not self-heal, so waiting is pointless.
 */
const PAYMENT_RULES: Rule[] = [
  { label: "payment-funds", pattern: /insufficient account funds/i },
  { label: "payment-credit", pattern: /credit balance is too low|insufficient (?:funds|balance|credit)/i },
  { label: "payment-required", pattern: /payment required|add (?:a )?payment (?:details|method)/i },
  // pi renders bare provider statuses as `402: {...}`, `... (402): ...` or `402 status code (no body)`.
  { label: "payment-402", pattern: /(?:^|[\s(])402(?::|\)|\s+status\b)/ },
];

/** Metered allowance exhausted; resets on an hourly / daily / weekly window. */
const QUOTA_RULES: Rule[] = [
  { label: "quota-usage-limit", pattern: /usage[_\-\s]?limit/i },
  { label: "quota-tier-limit-error", pattern: /GoUsageLimitError|FreeUsageLimitError/i },
  { label: "quota-insufficient", pattern: /insufficient[_\s]?quota|exceeded your current quota/i },
  { label: "quota-exceeded", pattern: /quota exceeded/i },
  { label: "quota-out-of-budget", pattern: /out of budget/i },
  { label: "quota-available-balance", pattern: /available balance/i },
  { label: "quota-zh", pattern: /使用上限|限额将在|额度(?:不足|已用尽|用尽|耗尽)|超出.{0,8}额度/ },
];

/** Needs a human, and is unambiguous enough to stop an unattended run immediately. */
const PERMANENT_RULES: Rule[] = [
  { label: "perm-auth", pattern: /login expired|session expired|invalid[_\s]?api[_\s]?key|incorrect api key|invalid[_\s]?authentication|authentication failed/i },
  { label: "perm-region", pattern: /unsupported_country_region_territory|country, region, or territory not supported/i },
  { label: "perm-model", pattern: /model is not supported|model not found|no such model|unsupported model/i },
  { label: "perm-provider", pattern: /no api provider registered/i },
  { label: "perm-workspace", pattern: /privacy settings/i },
];

/** First user-supplied pattern that matches, or undefined. Invalid regexes are skipped, never thrown. */
function matchUserPattern(sources: readonly string[] | undefined, text: string): string | undefined {
  if (!Array.isArray(sources)) return undefined;
  for (const source of sources) {
    if (typeof source !== "string" || !source.trim()) continue;
    try {
      if (new RegExp(source, "i").test(text)) return source;
    } catch {
      // A malformed config pattern must not break the settle handler.
    }
  }
  return undefined;
}

function matchRule(rules: Rule[], text: string): Rule | undefined {
  return rules.find((rule) => rule.pattern.test(text));
}

export function classifyStopError(
  message: string | undefined | null,
  options?: ClassifyOptions,
): StopErrorClassification {
  if (typeof message !== "string") return { kind: "other" };
  const text = message.trim();
  if (!text) return { kind: "other" };

  const ignored = matchUserPattern(options?.ignorePatterns, text);
  if (ignored) return { kind: "other", rule: `ignore:${ignored}` };

  const extra = matchUserPattern(options?.extraPatterns, text);
  if (extra) return { kind: "quota", rule: `extra:${extra}` };

  const transient = matchRule(TRANSIENT_GUARD, text);
  if (transient) return { kind: "other", rule: transient.label };

  const payment = matchRule(PAYMENT_RULES, text);
  if (payment) return { kind: "permanent", rule: payment.label };

  const quota = matchRule(QUOTA_RULES, text);
  if (quota) return { kind: "quota", rule: quota.label };

  const permanent = matchRule(PERMANENT_RULES, text);
  if (permanent) return { kind: "permanent", rule: permanent.label };

  return { kind: "other" };
}
