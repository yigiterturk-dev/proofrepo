import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import type { AuditCounts, AuditReport, CheckResult, CheckStatus, Severity } from "./types.js";

const VERSION = "0.1.0";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  ".venv",
  "venv"
]);

const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".php", ".cs"
]);

const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json"];
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock", "Cargo.lock", "go.sum", "composer.lock"];
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];
const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template", "env.example"];

interface RepositoryFacts {
  root: string;
  files: string[];
  readmePath: string | undefined;
  readme: string;
  packageJson: Record<string, unknown> | undefined;
  trackedFiles: string[];
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

function walk(root: string, current = root, output: string[] = []): string[] {
  if (output.length >= 20_000) return output;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) walk(root, absolute, output);
    else if (entry.isFile()) output.push(relative(root, absolute).replaceAll("\\", "/"));
    if (output.length >= 20_000) break;
  }
  return output;
}

function trackedFiles(root: string): string[] {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function loadFacts(input: string): RepositoryFacts {
  const root = resolve(input);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${root}`);
  }

  const files = walk(root);
  const readmePath = files.find((file) => /^readme(?:\.[^.]+)?$/i.test(file));
  const readme = readmePath ? readFileSync(join(root, readmePath), "utf8") : "";
  let packageJson: Record<string, unknown> | undefined;
  if (files.includes("package.json")) {
    try {
      packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      packageJson = undefined;
    }
  }

  return { root, files, readmePath, readme, packageJson, trackedFiles: trackedFiles(root) };
}

function result(
  id: string,
  title: string,
  status: CheckStatus,
  severity: Severity,
  summary: string,
  evidence: string[],
  recommendation?: string
): CheckResult {
  return recommendation
    ? { id, title, status, severity, summary, evidence, recommendation }
    : { id, title, status, severity, summary, evidence };
}

function getScripts(facts: RepositoryFacts): Record<string, string> {
  const scripts = facts.packageJson?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function hasTestFiles(files: string[]): boolean {
  return files.some((file) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(file));
}

function readFileIfExists(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
}

// Detect a runnable test command from Python-ecosystem sources, in addition to
// package.json#scripts. Returns a short human-readable label or undefined.
function pythonTestCommand(facts: RepositoryFacts): string | undefined {
  const configFiles = ["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg"];
  for (const file of configFiles) {
    if (!facts.files.includes(file)) continue;
    const content = readFileIfExists(facts.root, file);
    if (/pytest|\[tool\.pytest|\[pytest\]/i.test(content)) return `python -m pytest (${file})`;
  }
  if (facts.files.includes("Makefile")) {
    const content = readFileIfExists(facts.root, "Makefile");
    if (/^test\s*:/m.test(content)) return "make test";
  }
  if (facts.files.includes("requirements.txt")) {
    const content = readFileIfExists(facts.root, "requirements.txt");
    if (/pytest/i.test(content)) return "pytest (requirements.txt)";
  }
  return undefined;
}

// Detect quality commands (lint/typecheck/check/build) from Python-ecosystem
// sources, in addition to package.json#scripts.
function pythonQualityCommands(facts: RepositoryFacts): string[] {
  const commands: string[] = [];
  const configFiles = ["pyproject.toml", "tox.ini", "setup.cfg"];
  for (const file of configFiles) {
    if (!facts.files.includes(file)) continue;
    const content = readFileIfExists(facts.root, file);
    if (/\[tool\.ruff\]|\[tool\.mypy\]|\[tool\.black\]|\[tool\.flake8\]|ruff|mypy|flake8/i.test(content)) {
      commands.push(`lint (${file})`);
      break;
    }
  }
  if (facts.files.includes("Makefile")) {
    const content = readFileIfExists(facts.root, "Makefile");
    if (/^lint\s*:/m.test(content)) commands.push("make lint");
    if (/^check\s*:/m.test(content)) commands.push("make check");
    if (/^build\s*:/m.test(content)) commands.push("make build");
  }
  if (facts.files.includes(".pre-commit-config.yaml")) commands.push("pre-commit");
  return commands;
}

function readsEnvironment(facts: RepositoryFacts): boolean {
  const candidates = facts.files.filter((file) =>
    TEXT_EXTENSIONS.has(extension(file)) &&
    !/(^|\/)(test|tests|__tests__|fixtures)(\/|$)/i.test(file) &&
    !/\.(test|spec)\.[^.]+$/i.test(file)
  );
  for (const file of candidates) {
    const absolute = join(facts.root, file);
    if (statSync(absolute).size > 1_000_000) continue;
    const content = readFileSync(absolute, "utf8");
    if (/process\.env\b|import\.meta\.env\b|os\.environ\b|getenv\s*\(/.test(content)) return true;
  }
  return false;
}

function checksFor(facts: RepositoryFacts): CheckResult[] {
  const checks: CheckResult[] = [];
  const scripts = getScripts(facts);
  const gitDirectory = existsSync(join(facts.root, ".git"));
  checks.push(result(
    "git-repository",
    "Git repository",
    gitDirectory ? "pass" : "fail",
    "critical",
    gitDirectory ? "Git metadata is present." : "The directory is not initialized as a Git repository.",
    gitDirectory ? [".git/"] : [],
    gitDirectory ? undefined : "Run git init before publishing or collaborating."
  ));

  const hasReadme = Boolean(facts.readmePath && facts.readme.trim().length >= 80);
  checks.push(result(
    "readme",
    "Project explanation",
    hasReadme ? "pass" : "fail",
    "critical",
    hasReadme ? "A substantive README is present." : "A substantive README was not found.",
    facts.readmePath ? [facts.readmePath] : [],
    hasReadme ? undefined : "Explain the user problem, setup, validation commands, status, and limitations."
  ));

  const license = LICENSE_FILES.find((file) => facts.files.includes(file));
  checks.push(result(
    "license",
    "Reuse terms",
    license ? "pass" : "warn",
    "warning",
    license ? "A license file defines reuse terms." : "No common license file was found.",
    license ? [license] : [],
    license ? undefined : "Choose and add a license before inviting reuse."
  ));

  const manifests = MANIFESTS.filter((file) => facts.files.includes(file));
  checks.push(result(
    "manifest",
    "Dependency manifest",
    manifests.length ? "pass" : "warn",
    "critical",
    manifests.length ? "A recognized dependency or build manifest is present." : "No recognized dependency manifest was found.",
    manifests,
    manifests.length ? undefined : "Add the ecosystem manifest needed for reproducible setup."
  ));

  const lockfiles = LOCKFILES.filter((file) => facts.files.includes(file));
  checks.push(result(
    "lockfile",
    "Reproducible dependencies",
    manifests.length === 0 || lockfiles.length ? "pass" : "warn",
    "warning",
    manifests.length === 0
      ? "No lockfile requirement was inferred without a recognized manifest."
      : lockfiles.length
        ? "A recognized lockfile is present."
        : "A manifest exists but no recognized lockfile was found.",
    lockfiles,
    manifests.length > 0 && lockfiles.length === 0 ? "Commit the package manager lockfile." : undefined
  ));

  const workflows = facts.files.filter((file) => /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i.test(file));
  checks.push(result(
    "ci",
    "Continuous integration",
    workflows.length ? "pass" : "warn",
    "warning",
    workflows.length ? "At least one GitHub Actions workflow is present." : "No GitHub Actions workflow was found.",
    workflows,
    workflows.length ? undefined : "Add CI that runs the repository's documented validation commands."
  ));

  const testScript = scripts.test;
  const usefulTestScript = Boolean(testScript && !/no test|echo/i.test(testScript));
  const pythonTest = pythonTestCommand(facts);
  const hasTestCommand = usefulTestScript || Boolean(pythonTest);
  const testFiles = hasTestFiles(facts.files);
  const testEvidence = [
    usefulTestScript ? "package.json#scripts.test" : "",
    pythonTest ?? "",
    testFiles ? "test files detected" : ""
  ].filter(Boolean);
  checks.push(result(
    "tests",
    "Automated tests",
    hasTestCommand && testFiles ? "pass" : hasTestCommand || testFiles ? "warn" : "fail",
    "critical",
    hasTestCommand && testFiles
      ? "A test command and test files are present."
      : hasTestCommand || testFiles
        ? "Only part of the automated test evidence is present."
        : "No test command or test files were detected.",
    testEvidence,
    hasTestCommand && testFiles ? undefined : "Add a runnable test command and at least one meaningful test."
  ));

  const qualityScripts = ["lint", "typecheck", "check", "build"].filter((name) => typeof scripts[name] === "string");
  const pythonQuality = pythonQualityCommands(facts);
  const qualityCount = qualityScripts.length + pythonQuality.length;
  const qualityEvidence = [...qualityScripts.map((name) => `package.json#scripts.${name}`), ...pythonQuality];
  checks.push(result(
    "quality-commands",
    "Quality commands",
    qualityCount >= 2 ? "pass" : qualityCount === 1 ? "warn" : "fail",
    "warning",
    qualityCount ? `Detected ${qualityCount} quality command(s).` : "No common lint, typecheck, check, or build command was detected.",
    qualityEvidence,
    qualityCount >= 2 ? undefined : "Document automated static checks and build validation."
  ));

  const envUsage = readsEnvironment(facts);
  const envExample = ENV_EXAMPLES.find((file) => facts.files.includes(file));
  const trackedSecretFiles = facts.trackedFiles.filter((file) => /^\.env(?:\.|$)/.test(basename(file)) && !/\.(example|sample|template)$/.test(file));
  const envStatus: CheckStatus = trackedSecretFiles.length ? "fail" : envUsage && !envExample ? "warn" : "pass";
  checks.push(result(
    "environment-hygiene",
    "Environment-file hygiene",
    envStatus,
    "critical",
    trackedSecretFiles.length
      ? "One or more environment files appear to be tracked. Values were not read or printed."
      : envUsage && !envExample
        ? "Environment access was detected without a committed example file."
        : envUsage
          ? "Environment access and a safe example file were detected."
          : "No runtime environment access was detected in supported source files.",
    trackedSecretFiles.length ? trackedSecretFiles.map((file) => `tracked: ${file}`) : envExample ? [envExample] : [],
    envStatus === "pass" ? undefined : "Remove real environment files from Git history and document variable names in an example file without values."
  ));

  const gitignore = facts.files.includes(".gitignore") ? readFileSync(join(facts.root, ".gitignore"), "utf8") : "";
  const ignoresEnv = /(^|\n)\.env(?:\.\*|\*|$)/m.test(gitignore);
  checks.push(result(
    "gitignore",
    "Local-file exclusions",
    facts.files.includes(".gitignore") && (!envUsage || ignoresEnv) ? "pass" : "warn",
    "warning",
    facts.files.includes(".gitignore")
      ? envUsage && !ignoresEnv
        ? "A .gitignore exists but does not clearly exclude environment files."
        : "A .gitignore is present with relevant exclusions."
      : "No .gitignore file was found.",
    facts.files.includes(".gitignore") ? [".gitignore"] : [],
    facts.files.includes(".gitignore") && (!envUsage || ignoresEnv) ? undefined : "Exclude local secrets, generated output, and dependency directories."
  ));

  const imageEvidence = facts.files.filter((file) => /(^|\/)(docs|screenshots|assets)\/.*\.(png|jpe?g|webp|gif|svg)$/i.test(file));
  const readmeImages = /!\[[^\]]*\]\([^)]+\)|<img\b/i.test(facts.readme);
  checks.push(result(
    "visual-proof",
    "Visual proof",
    readmeImages || imageEvidence.length ? "pass" : "warn",
    "info",
    readmeImages || imageEvidence.length ? "Visual evidence is present." : "No screenshots, diagrams, or README images were detected.",
    imageEvidence.slice(0, 5),
    readmeImages || imageEvidence.length ? undefined : "Add a truthful screenshot, terminal capture, or architecture diagram."
  ));

  const urls = facts.readme.match(/https:\/\/[^\s)>\]]+/g) ?? [];
  const nonRepositoryUrls = urls.filter((url) => !/github\.com|shields\.io|npmjs\.com/i.test(url));
  checks.push(result(
    "demo-link",
    "Runnable or live proof",
    nonRepositoryUrls.length ? "pass" : "warn",
    "info",
    nonRepositoryUrls.length ? "The README links to external runnable or supporting evidence." : "No external demo or supporting link was detected.",
    nonRepositoryUrls.slice(0, 3),
    nonRepositoryUrls.length ? undefined : "Link a live demo, package page, or reproducible example when one exists."
  ));

  const contributionFiles = facts.files.filter((file) => /^(CONTRIBUTING|SECURITY)(\.[^.]+)?$/i.test(file));
  checks.push(result(
    "collaboration-docs",
    "Collaboration guidance",
    contributionFiles.length >= 2 ? "pass" : contributionFiles.length === 1 ? "warn" : "warn",
    "info",
    contributionFiles.length ? "At least one collaboration or security policy is present." : "No contribution or security policy was detected.",
    contributionFiles,
    contributionFiles.length >= 2 ? undefined : "Add concise CONTRIBUTING and SECURITY guidance for public collaboration."
  ));

  return checks;
}

function calculateScore(checks: CheckResult[]): number {
  const weights: Record<Severity, number> = { critical: 4, warning: 2, info: 1 };
  const values: Record<CheckStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  const maximum = checks.reduce((sum, check) => sum + weights[check.severity], 0);
  const achieved = checks.reduce((sum, check) => sum + weights[check.severity] * values[check.status], 0);
  return Math.round((achieved / maximum) * 100);
}

function count(checks: CheckResult[]): AuditCounts {
  return checks.reduce<AuditCounts>((counts, check) => {
    counts[check.status] += 1;
    return counts;
  }, { pass: 0, warn: 0, fail: 0 });
}

export function scanRepository(input: string): AuditReport {
  const facts = loadFacts(input);
  const checks = checksFor(facts);
  return {
    tool: "proofrepo",
    version: VERSION,
    generatedAt: new Date().toISOString(),
    target: facts.root,
    score: calculateScore(checks),
    counts: count(checks),
    checks,
    claimBoundary: "This report proves repository evidence only. It does not certify security, production readiness, compliance, ownership, or business outcomes."
  };
}
