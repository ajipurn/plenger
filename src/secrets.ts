/**
 * Recognising secrets in text, so that plenger can report them without ever printing
 * them. Nothing here keeps a secret's value.
 */

/** Words and shapes that mark a documentation placeholder rather than a real secret. */
export const PLACEHOLDER =
  /x{4}|\.{3}|<|your|example|placeholder|dummy|fake|changeme|replace|insert|not[-_ ]?needed|test|todo|redacted/i;

/**
 * Whether a string could be a real secret: long enough, mixed letters and digits, not
 * an obvious placeholder, and not too repetitive.
 */
export function looksLikeSecret(text: string): boolean {
  if (text.length < 16 || /\s/.test(text) || PLACEHOLDER.test(text)) return false;
  if (!/[A-Za-z]/.test(text) || !/\d/.test(text)) return false;
  return entropy(text) >= 3;
}

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Formats of keys and tokens, most specific first. `entropy`: the match must also look
 * random, to skip documentation placeholders such as `sk-xxxxxxxx`.
 */
export const SECRET_FORMATS: { name: string; pattern: RegExp; entropy?: true }[] = [
  { name: "Anthropic API key", pattern: /\bsk-ant-(?:api|admin)\d{2}-[\w-]{20,}/, entropy: true },
  { name: "OpenRouter API key", pattern: /\bsk-or-v1-[a-f0-9]{32,}/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[\w-]{20,}/, entropy: true },
  { name: "Google API key", pattern: /\bAIza[\w-]{35}\b/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})/ },
  { name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{30,}\b/, entropy: true },
  { name: "Groq API key", pattern: /\bgsk_[A-Za-z0-9]{40,}\b/ },
  { name: "xAI API key", pattern: /\bxai-[A-Za-z0-9]{40,}\b/ },
  { name: "Perplexity API key", pattern: /\bpplx-[A-Za-z0-9]{40,}\b/ },
  { name: "Replicate token", pattern: /\br8_[A-Za-z0-9]{30,}\b/ },
  { name: "Tavily API key", pattern: /\btvly-(?:dev-)?[A-Za-z0-9]{20,}\b/, entropy: true },
  { name: "LangSmith API key", pattern: /\blsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}\b/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, entropy: true },
  { name: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/,
  },
];

/** The first known secret format in a text, if any. */
export function findSecret(text: string): { name: string; match: string } | null {
  for (const format of SECRET_FORMATS) {
    for (const [match] of text.matchAll(new RegExp(format.pattern.source, "g"))) {
      if (PLACEHOLDER.test(match) || (format.entropy && !looksLikeSecret(match))) continue;
      return { name: format.name, match };
    }
  }
  return null;
}

/** `password: hunter2xyz`, `api key is ...`: a credential written out in prose. */
const CREDENTIAL_PHRASE =
  /\b(?:password|passwd|passphrase|api[_ -]?key|secret|access[_ -]?token|token)\s*(?:is|=|:)\s*["'`]?([^\s"'`{}]{8,})/gi;
const QUOTED = /(["'`])([^"'`\s]{16,})\1/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;

/** The kind of secret a text contains, if any: a known key format, or a credential written out. */
export function secretIn(text: string): string | null {
  const known = findSecret(text);
  if (known !== null) return known.name;
  for (const match of text.matchAll(CREDENTIAL_PHRASE)) {
    if (looksLikeSecret(match[1] as string)) return "credential";
  }
  return null;
}

/** Replaces known key formats, credentials written out and random-looking quoted strings with `<redacted>`. */
export function redact(text: string): string {
  let result = text.replace(PRIVATE_KEY_BLOCK, "<redacted>");
  for (const format of SECRET_FORMATS) {
    result = result.replace(new RegExp(format.pattern.source, "g"), (match) =>
      PLACEHOLDER.test(match) ? match : "<redacted>",
    );
  }
  result = result.replace(CREDENTIAL_PHRASE, (whole, value: string) =>
    looksLikeSecret(value) ? whole.replace(value, "<redacted>") : whole,
  );
  return result.replace(QUOTED, (whole, quote: string, inner: string) =>
    looksLikeSecret(inner) && !/[/.:]/.test(inner) ? `${quote}<redacted>${quote}` : whole,
  );
}

/** Redacts all text in the finished report, after analysis has used the original values. */
export function redactReport(report: object, credentials: string[] = []): void {
  const seen = new WeakSet<object>();
  const visit = (value: object): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(fields)) {
      if (typeof field === "string") {
        let text = field;
        for (const credential of credentials) text = text.replaceAll(credential, "<redacted>");
        fields[key] = redact(text);
      } else if (field !== null && typeof field === "object") visit(field);
    }
  };
  visit(report);
}
