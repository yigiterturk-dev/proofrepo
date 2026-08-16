import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "../src/scan.js";
import { toJson, toMarkdown } from "../src/report.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-test-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Useful project\n\nThis fixture demonstrates a documented tool with setup, validation, status, limitations, and a live example at https://example.com/demo.\n");
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n.env.*\n!.env.example\n");
  writeFileSync(join(root, ".env.example"), "API_URL=\n");
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "tsc --noEmit", build: "tsc" } }));
  writeFileSync(join(root, "src", "index.ts"), "export const endpoint = process.env.API_URL;\n");
  writeFileSync(join(root, "test", "index.test.ts"), "// fixture test\n");
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Contributing\n");
  writeFileSync(join(root, "SECURITY.md"), "# Security\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  return root;
}

test("reports strong repository evidence without making certification claims", () => {
  const root = fixture();
  writeFileSync(join(root, "vitest.config.ts"), "export default {}\n");
  writeFileSync(join(root, ".prettierrc.json"), "{}\n");
  const report = scanRepository(root);
  assert.ok(report.score >= 85);
  assert.equal(report.counts.fail, 0);
  const tests = report.checks.find((check) => check.id === "tests");
  const quality = report.checks.find((check) => check.id === "quality-commands");
  assert.ok(tests?.evidence.includes("vitest.config (Vitest configured)"));
  assert.ok(quality?.evidence.includes(".prettierrc (Prettier configured)"));
  assert.match(report.claimBoundary, /does not certify security/i);
  assert.match(toMarkdown(report), /ProofRepo evidence report/);
  assert.equal(JSON.parse(toJson(report)).tool, "proofrepo");
});

test("fails environment hygiene when a real env file is tracked", () => {
  const root = fixture();
  writeFileSync(join(root, ".env.production"), "SECRET=fixture-only\n");
  execFileSync("git", ["-C", root, "add", "-f", ".env.production"]);
  const report = scanRepository(root);
  const envCheck = report.checks.find((check) => check.id === "environment-hygiene");
  assert.equal(envCheck?.status, "fail");
  assert.deepEqual(envCheck?.evidence, ["tracked: .env.production"]);
  assert.ok(!toJson(report).includes("fixture-only"));
});

test("handles a plain directory and explains missing proof", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-plain-"));
  writeFileSync(join(root, "notes.txt"), "not a repository\n");
  const report = scanRepository(root);
  assert.ok(report.score < 50);
  assert.equal(report.checks.find((check) => check.id === "git-repository")?.status, "fail");
});

test("detects Python test and quality commands from pyproject.toml and Makefile", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-python-"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "README.md"), "# Python project\n\nA documented Python tool with setup, validation, status, and limitations.\n");
  writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.ruff]\nline-length = 100\n");
  writeFileSync(join(root, "Makefile"), "test:\n\tpython -m pytest\n\nlint:\n\truff check\n\ncheck:\n\tmake lint && make test\n");
  writeFileSync(join(root, "tests", "test_math.py"), "def test_add():\n    assert 1 + 1 == 2\n");
  const report = scanRepository(root);
  const tests = report.checks.find((check) => check.id === "tests");
  const quality = report.checks.find((check) => check.id === "quality-commands");
  assert.equal(tests?.status, "pass");
  assert.match(tests?.evidence.join(" ") ?? "", /make test/);
  assert.equal(quality?.status, "pass");
  assert.ok((quality?.evidence.length ?? 0) >= 2);
});

test("does not treat comments mentioning Python tools as runnable commands", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-python-comments-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "README.md"), "# Python project\n\nThis project may adopt pytest and ruff in a future release.\n");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"example\"\ndescription = \"pytest and ruff may be added later\"\n");
  writeFileSync(join(root, "requirements.txt"), "# pytest is not installed yet\nrequests==2.32.0\n");
  writeFileSync(join(root, "src", "math.py"), "def add(a, b):\n    return a + b\n");

  const report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "tests")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "quality-commands")?.status, "fail");
});

test("detects documented unittest commands and Python suffix-style test files", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-python-unittest-"));
  writeFileSync(join(root, "README.md"), "# Python project\n\nValidation:\n\n```bash\npython -m unittest discover\nruff check .\nmypy src\n```\n");
  writeFileSync(join(root, "math_test.py"), "import unittest\n\nclass MathTest(unittest.TestCase):\n    pass\n");

  const report = scanRepository(root);
  const tests = report.checks.find((check) => check.id === "tests");
  const quality = report.checks.find((check) => check.id === "quality-commands");
  assert.equal(tests?.status, "pass");
  assert.deepEqual(tests?.evidence, ["documented Python test command (README)", "test files detected"]);
  assert.equal(quality?.status, "pass");
  assert.deepEqual(quality?.evidence, ["ruff check (README)", "mypy (README)"]);
});

test("detects exact pytest requirements but ignores similarly named packages", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-python-requirements-"));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "README.md"), "# Python project\n\nA small package with automated validation and documented limitations.\n");
  writeFileSync(join(root, "requirements.txt"), "pytest-cov==6.0.0\npytest is planned for later\n");
  writeFileSync(join(root, "tests", "test_math.py"), "def test_math():\n    assert True\n");

  let report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "tests")?.status, "warn");

  writeFileSync(join(root, "requirements.txt"), "pytest>=8.0  # test runner\npytest-cov==6.0.0\n");
  report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "tests")?.status, "pass");
});

test("detects pytest dependencies in supported pyproject sections", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-python-pyproject-deps-"));
  writeFileSync(join(root, "README.md"), "# Python project\n\nA small package with validation and documented limitations.\n");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"example\"\ndescription = \"pytest is not configured\"\ndependencies = [\"requests>=2\"]\n");
  writeFileSync(join(root, "widget_test.py"), "def test_widget():\n    assert True\n");

  let report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "tests")?.status, "warn");

  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"example\"\n\n[project.optional-dependencies]\ntest = [\"pytest>=8; python_version >= '3.10'\", \"pytest-cov>=6\"]\n");
  report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "tests")?.status, "pass");
});

test("ignores empty or echo-only Node quality scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "proofrepo-node-placeholders-"));
  writeFileSync(join(root, "README.md"), "# Node project\n\nA package with setup, validation, status, and documented limitations.\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "", build: "echo not implemented" } }));

  const report = scanRepository(root);
  assert.equal(report.checks.find((check) => check.id === "quality-commands")?.status, "fail");
});
