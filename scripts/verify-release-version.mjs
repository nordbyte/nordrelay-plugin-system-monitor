#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageVersion = String(pkg.version ?? "").trim();
const expectedTag = `v${packageVersion}`;
const releaseTag = process.env.GITHUB_RELEASE_TAG || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
const requestedVersion = process.env.NORDRELAY_RELEASE_VERSION || process.env.INPUT_VERSION || "";

if (!packageVersion) fail("package.json does not define a version.");
if (releaseTag && releaseTag !== expectedTag) fail(`Release tag ${releaseTag} does not match package.json version ${packageVersion}; expected ${expectedTag}.`);
if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && requestedVersion !== packageVersion) {
  fail(`Requested version ${requestedVersion || "(missing)"} does not match package.json version ${packageVersion}.`);
}

console.log(`Release version verified: ${expectedTag}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
