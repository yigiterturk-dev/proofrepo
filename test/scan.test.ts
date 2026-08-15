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
  const report = scanRepository(fixture());
  assert.ok(report.score >= 85);
  assert.equal(report.counts.fail, 0);
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
