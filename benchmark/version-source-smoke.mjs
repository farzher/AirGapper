import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP_BUILD, APP_VERSION } from "../version.js";

assert.equal(APP_BUILD, `v${APP_VERSION}`);
assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
const gradle = await readFile(new URL("../android/app/build.gradle", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/build-apk.yml", import.meta.url), "utf8");
assert.match(gradle, /version\.js/);
assert.match(workflow, /Read app version/);
assert.doesNotMatch(workflow, /v0\.5\.361/);
console.log(`version source smoke passed: ${APP_BUILD}`);
