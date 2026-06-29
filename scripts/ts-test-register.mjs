/**
 * Registers the TypeScript-resolution hook (ts-test-loader.mjs) for the test
 * run. Passed via `node --import` so the resolve hook is active before any test
 * module is loaded. See ts-test-loader.mjs for why it's needed.
 */
import { register } from "node:module";

register("./ts-test-loader.mjs", import.meta.url);
