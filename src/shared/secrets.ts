/**
 * Recognising secrets in text, so that plenger can report them without ever printing
 * them. Nothing here keeps a secret's value.
 */

/** What every redacted secret is replaced with, wherever it appears in a report. */
export const REDACTED = "<redacted>";

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
function entropy(text: string): number {
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
const SECRET_FORMATS: { name: string; pattern: RegExp; entropy?: true }[] = [
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
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "GitLab token", pattern: /\bglpat-[\w-]{20,}/, entropy: true },
  { name: "Google OAuth client secret", pattern: /\bGOCSPX-[\w-]{28}/ },
  { name: "Google OAuth access token", pattern: /\bya29\.[\w-]{30,}/, entropy: true },
  {
    name: "Slack webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T\w{6,}\/B\w{6,}\/\w{16,}/,
  },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  },
];

/** The formats with global patterns, compiled once for scanning whole texts. */
const GLOBAL_FORMATS = SECRET_FORMATS.map((format) => ({
  ...format,
  global: new RegExp(format.pattern.source, "g"),
}));

/** A match of a format that is a real secret rather than a documentation placeholder. */
function isSecretMatch(format: (typeof SECRET_FORMATS)[number], match: string): boolean {
  return !PLACEHOLDER.test(match) && !(format.entropy && !looksLikeSecret(match));
}

/** The first known secret format in a text, if any. */
export function findSecret(text: string): { name: string; match: string } | null {
  for (const format of GLOBAL_FORMATS) {
    for (const [match] of text.matchAll(format.global)) {
      if (isSecretMatch(format, match)) return { name: format.name, match };
    }
  }
  return null;
}

/** `password: hunter2xyz`, `api key is ...`: a credential written out in prose. */
const CREDENTIAL_PHRASE =
  /\b(?:password|passwd|passphrase|api[_ -]?key|secret|access[_ -]?token|token)\s*(?:is|=|:)\s*["'`]?([^\s"'`{}()]{8,})/gi;
/** A quoted string in source code. */
const QUOTED = /(["'`])([^"'`\s]{20,})\1/g;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g;
/** A JSON web token: three base64url parts, the first two encoding JSON objects. */
const JWT = /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g;
/** The password in a URL's user information: `postgres://app:s3cret@db/app`. */
const URL_PASSWORD = /\b([a-z][a-z\d+.-]*:\/\/[^\s:@/"'`]*:)([^\s@/"'`]+)@/gi;
/** The credential of an authorization header: `Authorization: Bearer ...`. */
const AUTHORIZATION = /\b(Bearer|Basic|Token)(\s+)([\w.~+/-]{16,}=*)/g;
/**
 * A value given to a name for a credential, as code and configuration write it:
 * `AWS_SECRET_ACCESS_KEY=...`, `"db_password": "..."`, `SECRET_KEY = '...'`. The
 * groups are the name, the operator, the quote (or none) and the value.
 */
const ASSIGNED_CREDENTIAL =
  /\b([\w.-]*?(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|credentials?)[\w-]*)(["']?\s*(?:=|:|=>)\s*)(["'`]?)([^\s"'`,;{}()]+)\3/gi;

/** The kind of secret a text contains, if any: a known key format, or a credential written out. */
export function secretIn(text: string): string | null {
  const known = findSecret(text);
  if (known !== null) return known.name;
  for (const match of text.matchAll(CREDENTIAL_PHRASE)) {
    if (looksLikeSecret(match[1] as string)) return "credential";
  }
  return null;
}

/**
 * Whether a quoted string with no known format still looks like a generated key: long,
 * random, and mixing upper case, lower case and digits. Identifiers, model names
 * (`claude-sonnet-4-5-20250929`) and environment variable names do not.
 */
function looksRandom(text: string): boolean {
  if (text.length < 20 || /[\s/.:]/.test(text) || PLACEHOLDER.test(text)) return false;
  // `category=KB-Theme-2024-Alpha7` is a key=value expression; base64 padding stays at the end.
  if (/=[^=]/.test(text)) return false;
  if (!/[a-z]/.test(text) || !/[A-Z]/.test(text)) return false;
  if ((text.match(/\d/g)?.length ?? 0) < 2) return false;
  if (GENERATED_ID.test(text) || isCompoundIdentifier(text)) return false;
  return entropy(text) >= 3.5;
}

/** Ids that model APIs generate for calls, messages, runs and files; they are not credentials. */
const GENERATED_ID =
  /^(?:call|chatcmpl|msg|req|resp|run|thread|asst|toolu|tooluse|fc|rs|file)[_-]/i;

/**
 * `SW-Chat-22-Chia-fu-threat`, `bars-behaviour-2024-second`: several separator-joined parts
 * of which at least one is a plain word. Generated keys do not contain words.
 */
function isCompoundIdentifier(text: string): boolean {
  const parts = text.split(/[-_]/);
  return (
    parts.length >= 4 &&
    parts.every((part) => /^[A-Za-z0-9]+$/.test(part)) &&
    parts.some((part) => /^[A-Za-z]{3,}$/.test(part))
  );
}

/**
 * Masks an account identity for display: `semlakune.dev@gmail.com` becomes
 * `s•••@gmail.com`. Non-email identifiers keep their first two characters.
 */
export function maskAccount(account: string): string {
  const at = account.indexOf("@");
  if (at > 0) return `${account.slice(0, 1)}•••${account.slice(at)}`;
  return `${account.slice(0, 2)}•••`;
}

/**
 * Replaces what is known to be secret: private key blocks, known key formats,
 * credentials written out, and the given literal credentials found in the code.
 * Safe for any text, including plenger's own titles and messages.
 */
export function redactKnown(text: string, credentials: readonly string[] = []): string {
  let result = text;
  for (const credential of credentials) result = result.replaceAll(credential, REDACTED);
  result = result.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const format of GLOBAL_FORMATS) {
    result = result.replace(format.global, (match) =>
      isSecretMatch(format, match) ? REDACTED : match,
    );
  }
  result = result
    .replace(JWT, REDACTED)
    .replace(URL_PASSWORD, (whole, start: string, password: string) =>
      password.startsWith(REDACTED) || PLACEHOLDER.test(password) ? whole : `${start}${REDACTED}@`,
    )
    .replace(AUTHORIZATION, (whole, scheme: string, space: string, value: string) =>
      looksLikeSecret(value) ? `${scheme}${space}${REDACTED}` : whole,
    );
  return result.replace(CREDENTIAL_PHRASE, (whole, value: string) =>
    looksLikeSecret(value) ? whole.replace(value, REDACTED) : whole,
  );
}

/**
 * Redacts text copied from source code (snippets, prompts, code facts): what
 * `redactKnown` replaces, values given to credential names, and quoted strings that
 * look like generated keys.
 */
export function redact(text: string, credentials: readonly string[] = []): string {
  return redactKnown(text, credentials)
    .replace(
      ASSIGNED_CREDENTIAL,
      (whole, name: string, operator: string, quote: string, value: string) =>
        // `DB_PASSWORD=...` in an environment file holds text, unquoted.
        assignedCredential(value, quote !== "" || (ENVIRONMENT_NAME.test(name) && operator === "="))
          ? `${name}${operator}${quote}${REDACTED}${quote}`
          : whole,
    )
    .replace(QUOTED, (whole, quote: string, inner: string) =>
      looksRandom(inner) ? `${quote}${REDACTED}${quote}` : whole,
    );
}

const ENVIRONMENT_NAME = /^[A-Z][A-Z\d_]*$/;

/**
 * Whether a value given to a credential name is a credential. Text needs six
 * characters of two kinds (`hunter2x`, `S3cretPass`); a value that may be code
 * (`password = user.password`, `max_tokens = 1024`) must look random.
 */
function assignedCredential(value: string, text: boolean): boolean {
  if (value.startsWith(REDACTED) || PLACEHOLDER.test(value)) return false;
  if (!text) return looksLikeSecret(value);
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((kind) => kind.test(value));
  return value.length >= 6 && kinds.length >= 2;
}

/**
 * Redacts every string of a finished report after analysis has used the original
 * values. Code facts (`files[].facts`) are source text and get the full `redact`;
 * everything else is either already redacted at its source or written by plenger, so
 * only known secrets are replaced there and identifiers stay readable.
 */
export function redactReport(report: object, credentials: readonly string[] = []): void {
  const seen = new WeakSet<object>();
  const visit = (value: object, source: boolean): void => {
    if (seen.has(value)) return;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    for (const [key, field] of Object.entries(fields)) {
      if (typeof field === "string") {
        fields[key] = source ? redact(field, credentials) : redactKnown(field, credentials);
      } else if (field !== null && typeof field === "object") {
        visit(field, source || key === "facts");
      }
    }
  };
  visit(report, false);
}
