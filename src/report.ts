import type { AuditReport, CheckResult } from "./types.js";

const ICONS = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function evidence(check: CheckResult): string {
  return check.evidence.length ? check.evidence.map((item) => `\`${item}\``).join(", ") : "—";
}

export function toMarkdown(report: AuditReport): string {
  const lines = [
    "# ProofRepo evidence report",
    "",
    `- Target: \`${report.target}\``,
    `- Generated: ${report.generatedAt}`,
    `- Score: **${report.score}/100**`,
    `- Checks: ${report.counts.pass} pass, ${report.counts.warn} warning, ${report.counts.fail} fail`,
    "",
    "| Result | Check | Severity | Evidence | Summary |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const check of report.checks) {
    lines.push(`| ${ICONS[check.status]} | ${escapeCell(check.title)} | ${check.severity} | ${evidence(check)} | ${escapeCell(check.summary)} |`);
  }

  const recommendations = report.checks.filter((check) => check.status !== "pass" && check.recommendation);
  if (recommendations.length) {
    lines.push("", "## Recommended next actions", "");
    recommendations.forEach((check, index) => lines.push(`${index + 1}. **${check.title}:** ${check.recommendation}`));
  }

  lines.push("", "## Claim boundary", "", report.claimBoundary, "");
  return lines.join("\n");
}

export function toJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
