/**
 * Card Description Sanitization Pipeline
 *
 * Security component that prevents prompt injection attacks via kanban card
 * descriptions. Card descriptions are user-controlled input that flows directly
 * into agent work orders — this is a prompt injection surface.
 *
 * This pipeline raises the bar from "trivial exploit" to "requires targeted
 * effort" by catching the most common attack patterns: hidden HTML instructions,
 * exfiltration URLs, shell metacharacters, workflow file manipulation, and
 * secret file references.
 *
 * NOT FOOLPROOF: Sophisticated prompt injection can bypass keyword scanning.
 * This is defense-in-depth, not a silver bullet. (See spec §4.10.)
 *
 * INVARIANT: Pure function. No I/O. No async. No side effects.
 */

// ---- Public types ----

export type SanitizeWarningType =
  | 'html_comment'
  | 'suspicious_url'
  | 'shell_metachar'
  | 'workflow_file'
  | 'secret_file'
  | 'content_too_large';

export interface SanitizeWarning {
  type: SanitizeWarningType;
  detail: string;
  /** Character offset in the original input where the issue was found. */
  position?: number;
}

export interface SanitizeResult {
  /** The sanitized description (HTML comments stripped, rest preserved). */
  sanitized: string;
  /** All issues detected during sanitization. */
  warnings: SanitizeWarning[];
  /** True if the content is too dangerous to proceed (e.g., over size limit). */
  blocked: boolean;
}

export interface SanitizerConfig {
  /** Maximum allowed content length in characters. Default: 50_000. */
  maxContentLength: number;
  /**
   * Regex pattern strings for allowed URL domains.
   * Matched against the hostname portion of detected URLs.
   * Default: github.com, gitlab.com, stackoverflow.com, docs.*.dev
   */
  urlAllowlist: string[];
  /** If true, any warning results in blocked=true. Default: false. */
  blockOnWarnings: boolean;
  /** If true, strip HTML comments from output. Default: true. */
  stripHtmlComments: boolean;
}

// ---- Defaults ----

const DEFAULT_CONFIG: SanitizerConfig = {
  maxContentLength: 50_000,
  urlAllowlist: [
    '^github\\.com$',
    '^gitlab\\.com$',
    '^stackoverflow\\.com$',
    '^docs\\.[a-z0-9-]+\\.dev$',
  ],
  blockOnWarnings: false,
  stripHtmlComments: true,
};

// ---- Detection patterns ----

/**
 * HTML comment regex. Handles:
 * - Standard comments: <!-- ... -->
 * - Multi-line comments
 * - Nested/malformed comments (greedy match to -->)
 *
 * We use a non-greedy match within to handle multiple separate comments,
 * but with the 's' flag (dotAll) so '.' matches newlines.
 */
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

/**
 * URL detection. Matches http:// and https:// URLs.
 * Captures enough of the URL to extract the hostname.
 * Also catches percent-encoded variations of the scheme.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;

/**
 * Percent-encoded URL scheme detection.
 * Attackers may encode "http" as "%68%74%74%70" or similar.
 */
const ENCODED_URL_PATTERN = /%68%74%74%70(?:%73)?%3a%2f%2f[^\s"'<>)\]]+/gi;

/**
 * Shell metacharacter patterns — things that could execute commands
 * if naively interpolated into a shell context.
 *
 * Each entry: [pattern, human-readable description]
 */
const SHELL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Command substitution: $(command) — but NOT $(variable) style references
  // that are common in documentation. We flag all of them as a warning.
  [/\$\([^)]+\)/g, 'command substitution $(...)'],

  // Backtick command substitution: `command`
  // Tricky: backticks are legitimate in markdown for inline code.
  // We flag backtick expressions that look like commands (contain spaces
  // or shell operators), not single-word inline code references.
  // Actually, per spec we flag all backtick expressions as warnings (not blocks).
  // But we need to distinguish markdown code blocks from shell backticks.
  // Strategy: flag backtick content that contains shell-like patterns.
  [/`[^`]*(?:curl|wget|nc|bash|sh|eval|exec|rm\s|chmod|chown|cat\s|>|<|\|)[^`]*`/gi, 'backtick expression with shell command'],

  // Pipe to command: | command
  // Must be careful: | is used in markdown tables. Flag only when followed
  // by known dangerous commands.
  [/\|\s*(?:curl|wget|nc|bash|sh|tee|xargs|eval|exec|mail|sendmail)\b/gi, 'pipe to shell command'],

  // Output redirection: > file, >> file
  // Common in code examples, but dangerous if interpolated.
  [/(?:^|[^-])>\s*[/~\w][^\s]*/gm, 'output redirection'],

  // Command chaining: && command, ; command
  [/(?:&&|;\s*(?=[a-z]))\s*(?:curl|wget|nc|bash|sh|eval|exec|rm\s|chmod|cat\s)/gi, 'chained shell command'],

  // Environment variable exfiltration patterns
  [/\$\{?(?:AWS_|GITHUB_|SECRET_|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z_]*\}?/g, 'environment variable reference'],

  // Base64 decode piped to shell — classic exfiltration/execution pattern
  [/base64\s+(?:-d|--decode)\s*\|/gi, 'base64 decode piped to command'],
  [/echo\s+[A-Za-z0-9+/=]{20,}\s*\|\s*base64/gi, 'base64-encoded payload'],
];

/**
 * Workflow file patterns — files that control CI/CD pipelines.
 * An attacker creating/modifying these can execute arbitrary code.
 */
const WORKFLOW_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.github\/workflows\//gi, '.github/workflows/ directory'],
  [/\.gitlab-ci\.ya?ml/gi, '.gitlab-ci.yml'],
  [/Jenkinsfile/g, 'Jenkinsfile'],
  [/\.circleci\//gi, '.circleci/ directory'],
  [/\.travis\.ya?ml/gi, '.travis.yml'],
  [/azure-pipelines\.ya?ml/gi, 'azure-pipelines.yml'],
  [/\.buildkite\//gi, '.buildkite/ directory'],
];

/**
 * Secret/environment file patterns — files containing credentials.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|\s|\/|")\.env(?:\.[a-z]+)?(?:\s|$|"|')/gim, '.env file'],
  [/credentials\.json/gi, 'credentials.json'],
  [/secrets\.ya?ml/gi, 'secrets.yaml'],
  [/\.pem(?:\s|$|"|')/gi, '.pem file'],
  [/\.key(?:\s|$|"|')/gi, '.key file'],
  [/id_rsa(?:\.pub)?/gi, 'id_rsa key file'],
  [/id_ed25519(?:\.pub)?/gi, 'id_ed25519 key file'],
  [/\.keystore/gi, '.keystore file'],
  [/service[_-]?account[_-]?key/gi, 'service account key'],
  [/token\.json/gi, 'token.json'],
];

// ---- URL hostname extraction ----

/**
 * Extract the hostname from a URL string. Handles percent-encoded characters
 * and strips port numbers.
 *
 * Returns null if the URL is malformed beyond recovery.
 */
function extractHostname(url: string): string | null {
  try {
    // Decode any percent-encoding first
    const decoded = decodeURIComponent(url);
    // Use URL parser for robust extraction
    const parsed = new URL(decoded);
    return parsed.hostname.toLowerCase();
  } catch {
    // Fallback: manual extraction for malformed URLs
    const match = url.match(/https?:\/\/([^/:?\s#]+)/i);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]).toLowerCase();
      } catch {
        return match[1].toLowerCase();
      }
    }
    return null;
  }
}

/**
 * Check if a hostname matches any pattern in the allowlist.
 */
function isAllowlisted(hostname: string, allowlist: readonly string[]): boolean {
  return allowlist.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(hostname);
    } catch {
      // Invalid regex in config — fail closed (not allowlisted)
      return false;
    }
  });
}

// ---- Main sanitization function ----

/**
 * Sanitize a card description before it flows into an agent work order.
 *
 * Pure function — no I/O, no side effects. Returns sanitized text plus
 * any warnings/blocked status for the pipeline timeline.
 *
 * @param input - Raw card description from the kanban platform
 * @param config - Optional partial config (merged with defaults)
 */
export function sanitize(
  input: string,
  config?: Partial<SanitizerConfig>,
): SanitizeResult {
  const cfg: SanitizerConfig = { ...DEFAULT_CONFIG, ...config };
  const warnings: SanitizeWarning[] = [];

  // ---- Step 0: Content length check (fast reject) ----
  if (input.length > cfg.maxContentLength) {
    return {
      sanitized: '',
      warnings: [{
        type: 'content_too_large',
        detail: `Content length ${input.length} exceeds maximum ${cfg.maxContentLength}`,
        position: cfg.maxContentLength,
      }],
      blocked: true,
    };
  }

  // ---- Step 1: Detect and optionally strip HTML comments ----
  let sanitized = input;
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex reuse
  const commentRegex = new RegExp(HTML_COMMENT_PATTERN.source, HTML_COMMENT_PATTERN.flags);
  while ((match = commentRegex.exec(input)) !== null) {
    warnings.push({
      type: 'html_comment',
      detail: `HTML comment found: ${truncate(match[0], 80)}`,
      position: match.index,
    });
  }

  if (cfg.stripHtmlComments) {
    sanitized = sanitized.replace(HTML_COMMENT_PATTERN, '');
  }

  // ---- Step 2: Detect URLs to non-allowlisted domains ----
  // Check both normal and percent-encoded URL patterns
  const urlRegex = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);
  while ((match = urlRegex.exec(input)) !== null) {
    const hostname = extractHostname(match[0]);
    if (hostname !== null && !isAllowlisted(hostname, cfg.urlAllowlist)) {
      warnings.push({
        type: 'suspicious_url',
        detail: `Non-allowlisted URL: ${truncate(match[0], 120)} (host: ${hostname})`,
        position: match.index,
      });
    }
  }

  // Also check percent-encoded URLs that might bypass the primary regex
  const encodedUrlRegex = new RegExp(ENCODED_URL_PATTERN.source, ENCODED_URL_PATTERN.flags);
  while ((match = encodedUrlRegex.exec(input)) !== null) {
    warnings.push({
      type: 'suspicious_url',
      detail: `Percent-encoded URL detected: ${truncate(match[0], 120)}`,
      position: match.index,
    });
  }

  // ---- Step 3: Detect shell metacharacters ----
  for (const [pattern, description] of SHELL_PATTERNS) {
    const shellRegex = new RegExp(pattern.source, pattern.flags);
    while ((match = shellRegex.exec(input)) !== null) {
      warnings.push({
        type: 'shell_metachar',
        detail: `Shell metacharacter: ${description} — ${truncate(match[0], 80)}`,
        position: match.index,
      });
    }
  }

  // ---- Step 4: Detect workflow file references ----
  for (const [pattern, description] of WORKFLOW_PATTERNS) {
    const wfRegex = new RegExp(pattern.source, pattern.flags);
    while ((match = wfRegex.exec(input)) !== null) {
      warnings.push({
        type: 'workflow_file',
        detail: `Workflow file reference: ${description}`,
        position: match.index,
      });
    }
  }

  // ---- Step 5: Detect secret/env file references ----
  for (const [pattern, description] of SECRET_PATTERNS) {
    const secretRegex = new RegExp(pattern.source, pattern.flags);
    while ((match = secretRegex.exec(input)) !== null) {
      warnings.push({
        type: 'secret_file',
        detail: `Secret file reference: ${description}`,
        position: match.index,
      });
    }
  }

  // ---- Determine blocked status ----
  const blocked = cfg.blockOnWarnings && warnings.length > 0;

  return { sanitized, warnings, blocked };
}

// ---- Helpers ----

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ---- Convenience: create a configured sanitizer ----

/**
 * Create a sanitizer function with a baked-in config.
 * Useful when the same config applies to all cards in a workspace.
 */
export function createSanitizer(
  config: Partial<SanitizerConfig>,
): (input: string) => SanitizeResult {
  return (input: string) => sanitize(input, config);
}

export { DEFAULT_CONFIG as defaultSanitizerConfig };
