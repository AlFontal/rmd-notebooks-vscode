#!/usr/bin/env node

const packageJson = require("../package.json");

const explicitTag = process.argv[2];
const eventName = process.env.GITHUB_EVENT_NAME || "";
const refType = process.env.GITHUB_REF_TYPE || "";
const tagName = explicitTag || process.env.GITHUB_REF_NAME || "";

if (!explicitTag && eventName !== "release" && refType !== "tag") {
  console.log("No release tag context detected; skipping version check.");
  process.exit(0);
}

const expectedTag = `v${packageJson.version}`;

if (tagName !== expectedTag) {
  console.error(`Release tag mismatch: expected ${expectedTag}, got ${tagName || "(empty)"}.`);
  process.exit(1);
}

console.log(`Release tag matches package version: ${expectedTag}`);
