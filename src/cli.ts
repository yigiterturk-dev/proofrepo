#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanRepository } from "./scan.js";
import { toJson, toMarkdown } from "./report.js";
import type { FailOn, OutputFormat } from "./types.js";

interface Options {
  path: string;
  format: OutputFormat;
  output?: string;
  failOn: FailOn;
  badge?: boolean;
}

const HELP = `proofrepo — evidence-first repository showcase audit

Usage:
  proofrepo [path] [--format markdown|json] [--output file] [--fail-on critical|warning|off] [--badge]

Options:
  --format   Report format (default: markdown)
  --output   Write to a file instead of stdout
  --fail-on  Exit non-zero on critical failures, any warning/failure, or never
  --badge    Generate proofrepo-badge.svg with the audit score
  --help     Show this help
  --version  Show the version
`;

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseArgs(args: string[]): Options {
  let path = ".";
  let format: OutputFormat = "markdown";
  let output: string | undefined;
  let failOn: FailOn = "critical";
  let badge = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--format") {
      const value = valueAfter(args, index, arg);
      if (value !== "markdown" && value !== "json") throw new Error(`Unsupported format: ${value}`);
      format = value;
      index += 1;
    } else if (arg === "--output") {
      output = valueAfter(args, index, arg);
      index += 1;
    } else if (arg === "--fail-on") {
      const value = valueAfter(args, index, arg);
      if (value !== "critical" && value !== "warning" && value !== "off") throw new Error(`Unsupported fail-on level: ${value}`);
      failOn = value;
      index += 1;
    } else if (arg === "--badge") {
      badge = true;
    } else if (!arg.startsWith("--")) {
      path = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const result: Options = { path, format, failOn, badge };
  if (output !== undefined) result.output = output;
  return result;
}

function exitCode(options: Options, report: ReturnType<typeof scanRepository>): number {
  if (options.failOn === "off") return 0;
  if (options.failOn === "warning") return report.checks.some((check) => check.status !== "pass") ? 1 : 0;
  return report.checks.some((check) => check.status === "fail" && check.severity === "critical") ? 1 : 0;
}

function generateSvgBadge(score: number): string {
  const color = score >= 85 ? "#31c48d" : score >= 60 ? "#fbbf24" : "#f87171";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="130" height="20" viewBox="0 0 130 20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="a">
    <rect width="130" height="20" rx="3" fill="#fff"/>
  </mask>
  <g mask="url(#a)">
    <rect width="80" height="20" fill="#555"/>
    <rect x="80" width="50" height="20" fill="${color}"/>
    <rect width="130" height="20" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110">
    <text x="410" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="700">proofrepo</text>
    <text x="410" y="140" transform="scale(.1)" textLength="700">proofrepo</text>
    <text x="1040" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="380">${score}%</text>
    <text x="1040" y="140" transform="scale(.1)" textLength="380">${score}%</text>
  </g>
</svg>`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--version")) {
    process.stdout.write("0.1.0\n");
    return;
  }

  try {
    const options = parseArgs(args);
    const report = scanRepository(options.path);
    const rendered = options.format === "json" ? toJson(report) : toMarkdown(report);
    if (options.output) writeFileSync(resolve(options.output), rendered, "utf8");
    else process.stdout.write(rendered);

    if (options.badge) {
      const badgeSvg = generateSvgBadge(report.score);
      writeFileSync(resolve(options.path, "proofrepo-badge.svg"), badgeSvg, "utf8");
    }

    process.exitCode = exitCode(options, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`proofrepo: ${message}\n`);
    process.exitCode = 2;
  }
}

main();
