/**
 * Module-resolution hook for `node --test`.
 *
 * The source uses extensionless relative imports (`../claude`) and the `@/`
 * path alias, both of which Next.js / tsconfig `bundler` resolution handle but
 * plain Node's ESM resolver does not. Our unit tests run on bare
 * `node --experimental-strip-types`, so without this hook any test whose module
 * transitively imports another source file fails with ERR_MODULE_NOT_FOUND.
 *
 * This `resolve` hook: (1) maps the `@/` alias to `src/`, and (2) when a
 * specifier doesn't resolve as-is, retries it with `.ts` / `.tsx` / `/index.ts`
 * appended. Node's built-in `--experimental-strip-types` loader then compiles
 * the resolved `.ts` file, so no `load` hook is needed here.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");

function tryTsExtensions(fileUrl) {
  let base;
  try {
    base = fileURLToPath(fileUrl);
  } catch {
    return null;
  }
  for (const cand of [base + ".ts", base + ".tsx", path.join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;

  // `@/...` path alias → absolute file URL under src/ (extensionless for now).
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(path.join(SRC, spec.slice(2))).href;
  }

  try {
    return await nextResolve(spec, context);
  } catch (err) {
    // Extensionless import: resolve relative to the importing module, then try
    // the TypeScript extensions.
    try {
      const candidateBase = spec.startsWith("file:")
        ? spec
        : new URL(spec, context.parentURL).href;
      const resolved = tryTsExtensions(candidateBase);
      if (resolved) return { url: resolved, shortCircuit: true };
    } catch {
      /* fall through to original error */
    }
    throw err;
  }
}
