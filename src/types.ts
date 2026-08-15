export type CheckStatus = "pass" | "warn" | "fail";
export type Severity = "critical" | "warning" | "info";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  severity: Severity;
  summary: string;
  evidence: string[];
  recommendation?: string;
}

export interface AuditCounts {
  pass: number;
  warn: number;
  fail: number;
}

export interface AuditReport {
  tool: "proofrepo";
  version: string;
  generatedAt: string;
  target: string;
  score: number;
  counts: AuditCounts;
  checks: CheckResult[];
  claimBoundary: string;
}

export type OutputFormat = "markdown" | "json";
export type FailOn = "critical" | "warning" | "off";
