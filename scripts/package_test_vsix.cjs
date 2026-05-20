#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageJson = require("../package.json");

function git(args, fallback) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function slug(value) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "local";
}

const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git(["branch", "--show-current"], "local");
const sha = (process.env.GITHUB_SHA || git(["rev-parse", "--short", "HEAD"], "unknown")).slice(0, 12);
const suffix = slug(process.argv[2] || `${branch}-${sha}`);
const outputFile = `${packageJson.name}-${packageJson.version}-${suffix}.vsix`;

fs.rmSync(outputFile, { force: true });
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vsce", "package", "--out", outputFile], {
  stdio: "inherit"
});

console.log(`Packaged test VSIX: ${path.resolve(outputFile)}`);
