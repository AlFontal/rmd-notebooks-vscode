#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packagePath = path.join(root, "package.json");
const originalPackageText = fs.readFileSync(packagePath, "utf8");
const packageJson = JSON.parse(originalPackageText);
const variant = process.argv[2] || "marketplace";
const suffix = process.argv[3];

if (!["marketplace", "openvsx"].includes(variant)) {
  throw new Error(`Unknown VSIX variant: ${variant}`);
}

function outputName() {
  return [
    packageJson.name,
    packageJson.version,
    variant,
    suffix
  ].filter(Boolean).join("-") + ".vsix";
}

function npxBin() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function readPackagedManifest(vsixPath) {
  const raw = execFileSync("unzip", ["-p", vsixPath, "extension/package.json"], {
    cwd: root,
    encoding: "utf8"
  });
  return JSON.parse(raw);
}

function assertDependencyPolicy(vsixPath) {
  const manifest = readPackagedManifest(vsixPath);
  const dependencies = manifest.extensionDependencies || [];
  const hasRExtensionDependency = dependencies.includes("REditorSupport.r");

  if (variant === "marketplace" && !hasRExtensionDependency) {
    throw new Error("Marketplace VSIX must keep extensionDependencies: REditorSupport.r");
  }

  if (variant === "openvsx" && hasRExtensionDependency) {
    throw new Error("Open VSX VSIX must not hard-depend on REditorSupport.r");
  }
}

const outputFile = outputName();
const outputPath = path.join(root, outputFile);
const manifest = JSON.parse(originalPackageText);

if (variant === "openvsx") {
  delete manifest.extensionDependencies;
}

fs.rmSync(outputPath, { force: true });

try {
  if (variant === "openvsx") {
    fs.writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  execFileSync(npxBin(), ["vsce", "package", "--out", outputFile], {
    cwd: root,
    stdio: "inherit"
  });
} finally {
  fs.writeFileSync(packagePath, originalPackageText);
}

assertDependencyPolicy(outputPath);
console.log(`Packaged ${variant} VSIX: ${outputPath}`);
