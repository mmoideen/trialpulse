/**
 * Prompt-injection and abuse heuristics.
 *
 * These flags never block a query on their own — a clinical user legitimately
 * asks about "instructions to sites". They are recorded on the audit record so
 * compliance can review patterns, and they harden the system prompt.
 */

export interface InjectionScan {
  flags: string[];
  /** True when the query should be refused outright. */
  block: boolean;
}

const PATTERNS: Array<{ flag: string; re: RegExp; block: boolean }> = [
  {
    flag: 'instruction_override',
    re: /\b(ignore|disregard|forget|override)\b[^.?!]{0,40}\b(previous|prior|above|earlier|all)\b[^.?!]{0,40}\b(instruction|prompt|rule|direction)/i,
    block: true,
  },
  {
    flag: 'system_prompt_exfiltration',
    re: /\b(system prompt|your instructions|initial prompt|developer message)\b/i,
    block: true,
  },
  {
    flag: 'role_escalation',
    re: /\b(act as|pretend to be|you are now|switch to)\b[^.?!]{0,40}\b(regulatory_affairs|it_admin|administrator|admin|unrestricted|god mode)\b/i,
    block: true,
  },
  {
    flag: 'rbac_bypass_request',
    re: /\b(bypass|disable|turn off|remove)\b[^.?!]{0,40}\b(rbac|filter|permission|access control|redaction)\b/i,
    block: true,
  },
  {
    flag: 'patient_identifier_request',
    re: /\b(patient (name|id|identifier|initials)|subject (name|initials)|mrn|date of birth|dob)\b/i,
    block: false,
  },
  {
    flag: 'encoded_payload',
    re: /\b(base64|rot13|hex decode)\b|(?:[A-Za-z0-9+/]{60,}={0,2})/,
    block: false,
  },
];

export function scanForInjection(query: string): InjectionScan {
  const flags: string[] = [];
  let block = false;
  for (const p of PATTERNS) {
    if (p.re.test(query)) {
      flags.push(p.flag);
      if (p.block) block = true;
    }
  }
  return { flags, block };
}
