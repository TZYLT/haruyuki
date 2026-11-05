/**
 * Licence metadata for the built-in embedding models (48-1 §6.4/R-23).
 *
 * The wizard shows this before a download and `NOTICE`/`THIRD-PARTY-NOTICES`
 * cite the same values. Weights are downloaded, never shipped in the npm
 * package, so the constants are the attribution contract rather than build
 * input. Kept apart from `model-manifest.ts` so that file stays under the
 * source-file-size ceiling; it imports nothing.
 *
 * Layer: `backend/local/embedding/` leaf; no imports.
 */

/** Licence metadata shown by the wizard before a download (48-1 §6.4). */
export interface EmbeddingModelLicense {
  /** SPDX identifier (`MIT`, `Apache-2.0`). */
  readonly id: string;
  readonly name: string;
  /** Canonical licence URL (https). */
  readonly url: string;
  /** Whether the weights may be redistributed; true only for permissive terms. */
  readonly redistributable: boolean;
  /** One-line disclosure surfaced next to the download confirmation. */
  readonly notice: string;
  /** Full licence text when it is short enough to embed (`MIT`). */
  readonly text: string | null;
}

/**
 * The MIT licence under which `BAAI/bge-small-zh-v1.5` is published. The ONNX
 * conversion (`Xenova/*`) is a derivative of those weights and keeps the same
 * terms; the notice names the upstream authors, not the converter.
 */
export const BGE_ZH_LICENSE: EmbeddingModelLicense = {
  id: "MIT",
  name: "MIT License",
  url: "https://opensource.org/licenses/MIT",
  redistributable: true,
  notice:
    "MIT. Weights are downloaded, never shipped in the npm package; attribution: BAAI/bge-small-zh-v1.5.",
  text: `MIT License

Copyright (c) 2023 Beijing Academy of Artificial Intelligence (BAAI)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

/** MIT terms for `BAAI/bge-m3`; the Xenova ONNX conversion keeps them. */
export const BGE_M3_LICENSE: EmbeddingModelLicense = {
  ...BGE_ZH_LICENSE,
  notice:
    "MIT. Weights are downloaded, never shipped in the npm package; attribution: BAAI/bge-m3.",
};

/** Apache-2.0 terms of `Qwen/Qwen3-Embedding-0.6B` (48-1 §5.2/§6.4). */
export const QWEN3_EMBEDDING_LICENSE: EmbeddingModelLicense = {
  id: "Apache-2.0",
  name: "Apache License 2.0",
  url: "https://www.apache.org/licenses/LICENSE-2.0",
  redistributable: true,
  notice:
    "Apache-2.0. Weights are downloaded, never shipped in the npm package; attribution: Qwen/Qwen3-Embedding-0.6B.",
  text: null,
};
