// Removes credentials from anything that is stored or returned to a client.

const PATTERNS: RegExp[] = [
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{30,})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{35})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g
];

const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*["']?)([^\s"']{6,})/gi;

const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g;

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export class Redactor {
  private readonly literals: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.literals = Object.entries(env)
      .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
      .map(([, value]) => value as string)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const literal of this.literals) out = out.split(literal).join('[REDACTED]');
    for (const re of PATTERNS) {
      out = out.replace(re, (_m, first: string, last?: string) =>
        last && first.startsWith('-----BEGIN') ? `${first}\n[REDACTED]\n${last}` : '[REDACTED]'
      );
    }
    out = out.replace(BEARER, '$1[REDACTED]');
    out = out.replace(ASSIGNMENT, '$1$2[REDACTED]');
    return out;
  }
}
