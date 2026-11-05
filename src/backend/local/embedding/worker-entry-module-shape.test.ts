/**
 * The `onnxruntime-node` export shapes `createOnnxRuntimeLoader` must accept.
 *
 * The real package exposes `InferenceSession` as a **class** (a function with a
 * static `create`) and `Tensor` as a constructor; a previous guard required a
 * plain object and rejected every genuine install with "does not expose
 * InferenceSession/Tensor". These fixtures are CJS files written to a temp
 * runtime directory, so no ORT binary and no network are involved.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOnnxRuntimeLoader } from "./worker-entry";

function writeOrtPackage(root: string, source: string): void {
  const packageDir = join(root, "node_modules", "onnxruntime-node");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "onnxruntime-node", main: "index.cjs" }),
  );
  writeFileSync(join(packageDir, "index.cjs"), source);
}

describe("createOnnxRuntimeLoader module shapes", () => {
  test("accepts the real package shape: InferenceSession is a class", async () => {
    const root = mkdtempSync(join(tmpdir(), "hryk-onnx-class-"));
    try {
      writeOrtPackage(
        root,
        [
          "class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } }",
          "class InferenceSession {",
          "  static async create() {",
          '    return { inputNames: ["input_ids", "attention_mask"], outputNames: ["last_hidden_state"], async run() { return {}; } };',
          "  }",
          "}",
          "module.exports = { InferenceSession, Tensor };",
        ].join("\n"),
      );
      const runtime = await createOnnxRuntimeLoader()({ runtimeDir: root });
      const session = await runtime.createSession({
        runtimeDir: root,
        modelPath: "model.onnx",
      });
      expect(session.inputNames).toEqual(["input_ids", "attention_mask"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts an interop module that nests the exports under default", async () => {
    const root = mkdtempSync(join(tmpdir(), "hryk-onnx-default-"));
    try {
      writeOrtPackage(
        root,
        [
          "class Tensor { constructor(type, data, dims) { this.data = data; this.dims = dims; } }",
          "module.exports = {",
          "  default: {",
          '    InferenceSession: { async create() { return { inputNames: ["input_ids", "attention_mask"], outputNames: [], async run() { return {}; } }; } },',
          "    Tensor,",
          "  },",
          "};",
        ].join("\n"),
      );
      const runtime = await createOnnxRuntimeLoader()({ runtimeDir: root });
      const session = await runtime.createSession({
        runtimeDir: root,
        modelPath: "model.onnx",
      });
      expect(session.inputNames).toEqual(["input_ids", "attention_mask"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
