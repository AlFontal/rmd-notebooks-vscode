#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const path = require("node:path");

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

for (const variant of ["marketplace", "openvsx"]) {
  execFileSync(process.execPath, [path.join(__dirname, "package_variant_vsix.cjs"), variant, suffix], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit"
  });
}

console.log("Packaged test VSIX variants.");
