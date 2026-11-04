/**
 * Imports a package out of an installed embedding runtime directory (C2 layout:
 * `<runtimeDir>/node_modules/...`, written by `runtime-fetch.ts`).
 *
 * The worker resolves the package relative to `runtimeDir` instead of its own
 * module graph, so a downloaded closure is loaded from the cache and never from
 * the harness bundle. `require` is attempted first (the closure ships CJS entry
 * points); an ESM-only package falls back to a dynamic `import()` of the
 * resolved file URL. Every other failure is rethrown — a missing package and a
 * broken package must stay distinguishable in the init error frame.
 *
 * Layer: `backend/local/embedding/`; imports only node builtins.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function isEsmRequireError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "ERR_REQUIRE_ESM" ||
      (typeof (error as { message?: unknown }).message === "string" &&
        (error as { message: string }).message.includes(
          "require() of ES Module",
        )))
  );
}

/** Resolve `specifier` from `runtimeDir`'s closure and load it. */
export async function importRuntimeModule(
  runtimeDir: string,
  specifier: string,
): Promise<unknown> {
  const nodeRequire = createRequire(join(runtimeDir, "package.json"));
  let resolved: string;
  try {
    resolved = nodeRequire.resolve(specifier, {
      paths: [join(runtimeDir, "node_modules")],
    });
  } catch (error) {
    throw new Error(
      `The embedding runtime package "${specifier}" is not installed under ${runtimeDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return nodeRequire(resolved);
  } catch (error) {
    if (!isEsmRequireError(error)) throw error;
    return await import(pathToFileURL(resolved).href);
  }
}
