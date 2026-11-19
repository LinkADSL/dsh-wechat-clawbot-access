/**
 * QR Code matrix generation for the WeChat ClawBot runtime.
 *
 * Pure Node.js ESM with **no third-party runtime dependencies**. It wraps the
 * vendored MIT encoder `qrcode-generator@1.4.4` by Kazuhiko Arase, which is
 * shipped as a CommonJS file (`vendor/qrcode-generator.cjs`) and loaded here
 * through `createRequire`.
 *
 * Vendor provenance
 *   upstream : qrcode-generator@1.4.4 (https://github.com/kazuhikoarase/qrcode-generator)
 *   license  : MIT, Copyright (c) 2009 Kazuhiko Arase
 *              (the upstream copyright/license header is retained verbatim in the vendor file)
 *   sha256   : 18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780
 *
 * Public contract (must stay in sync with the daemon that imports it):
 *
 *   createQrMatrix(text, { ecc?: 'L'|'M'|'Q'|'H', border?: number })
 *     -> { size: number, modules: boolean[][], version: number, ecc: string, text: string }
 *        modules[row][col] === true means a dark module.
 *        size is the module count WITHOUT the quiet zone.
 *        version is the QR version (1..40), auto-selected from `text`.
 *        `border` is validated and attached as a non-enumerable hint for
 *        toAscii(); it is not part of the enumerable result contract.
 *
 *   toAscii(matrix, { border?: number, dark?: string, light?: string }) -> string
 *        Multi-line terminal rendering of a matrix returned by createQrMatrix().
 *
 * The encoder is a classic QR Code byte-mode encoder: version 0 tells the
 * vendor to auto-select the smallest version that fits, and payload bytes are
 * UTF-8 (the vendor's default string-to-bytes is Latin-1 truncation, so it is
 * overridden once below).
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {(typeNumber: number, errorCorrectionLevel: string) => any} */
const qrcode = require('./vendor/qrcode-generator.cjs');

if (typeof qrcode !== 'function' || !qrcode.stringToBytesFuncs) {
  throw new TypeError(
    'qr.mjs: failed to load vendor/qrcode-generator.cjs (expected the qrcode-generator factory function)',
  );
}

// The vendor defaults to a Latin-1/charCode-truncating stringToBytes. Use its
// built-in UTF-8 implementation so any non-ASCII payload encodes correctly
// (ASCII, including the iLink URLs this module targets, is identical either way).
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

/** Error-correction levels accepted by createQrMatrix(), weakest -> strongest. */
const ECC_LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);
const DEFAULT_ECC = 'M';

/** Default quiet-zone width in modules (QR spec recommends 4). */
const DEFAULT_BORDER = 4;

/** Defensive upper bound for a quiet zone; guards against absurd memory use. */
const MAX_BORDER = 100;

/**
 * Byte-mode capacities (UTF-8 bytes, no ECI) of a version-40 QR code per ECC
 * level, i.e. the largest payload a standard byte-mode encoder can hold.
 * Used to reject over-long input with a clear error before invoking the vendor
 * (whose auto-version loop silently caps at version 40).
 */
const BYTE_CAPACITY_VERSION_40 = Object.freeze({
  L: 2953,
  M: 2331,
  Q: 1663,
  H: 1273,
});

const DEFAULT_ASCII_DARK = '\u2588\u2588'; // "██", two chars keep the aspect ratio square-ish
const DEFAULT_ASCII_LIGHT = '  ';

/**
 * Generate a QR matrix for `text`.
 *
 * @param {string} text - Payload to encode (non-empty). UTF-8 byte mode.
 * @param {{ ecc?: 'L'|'M'|'Q'|'H', border?: number }} [options]
 *   ecc    - error-correction level, default 'M'. Case-insensitive; normalized
 *            to upper case in the result.
 *   border - quiet-zone width in modules, default 4. Validated and attached as
 *            a non-enumerable `border` hint on the result (used by toAscii).
 * @returns {{ size: number, modules: boolean[][], version: number, ecc: string, text: string }}
 *   modules[row][col] === true means a dark module; `size` excludes quiet zone.
 * @throws {TypeError} text/options/ecc have invalid types.
 * @throws {RangeError} text is empty, text exceeds version-40 capacity, or
 *   border/ecc values are out of range.
 */
export function createQrMatrix(text, options) {
  if (typeof text !== 'string') {
    throw new TypeError('createQrMatrix: text must be a string');
  }
  if (text.length === 0) {
    throw new RangeError('createQrMatrix: text must not be empty (nothing to encode)');
  }

  const opts = readOptions(options, 'createQrMatrix');
  const ecc = readEcc(opts.ecc, 'createQrMatrix');
  const border = readBorder(opts.border, 'createQrMatrix', DEFAULT_BORDER);

  const byteLength = Buffer.byteLength(text, 'utf8');
  const capacity = BYTE_CAPACITY_VERSION_40[ecc];
  if (byteLength > capacity) {
    throw new RangeError(
      `createQrMatrix: text is too long: ${byteLength} UTF-8 bytes exceeds the ` +
        `${capacity}-byte capacity of a version-40 QR code at ECC ${ecc}`,
    );
  }

  let qr;
  try {
    qr = qrcode(0, ecc); // version 0 = auto-select the smallest version that fits
    qr.addData(text, 'Byte');
    qr.make();
  } catch (cause) {
    throw new Error(
      `createQrMatrix: QR encoder failed (ecc=${ecc}, bytes=${byteLength}): ${describeError(cause)}`,
      { cause },
    );
  }

  const size = qr.getModuleCount();
  const version = (size - 17) / 4;
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > 40 ||
    size !== 21 + (version - 1) * 4
  ) {
    throw new Error(`createQrMatrix: QR encoder returned an unexpected module count: ${size}`);
  }

  const modules = new Array(size);
  for (let row = 0; row < size; row += 1) {
    const line = new Array(size);
    for (let col = 0; col < size; col += 1) {
      const dark = qr.isDark(row, col);
      if (dark !== true && dark !== false) {
        throw new Error(`createQrMatrix: QR encoder left module (${row}, ${col}) undefined`);
      }
      line[col] = dark;
    }
    modules[row] = line;
  }

  const matrix = { size, modules, version, ecc, text };

  // Non-enumerable so the enumerable result keeps exactly the five contracted
  // fields; toAscii() still reads the hint. structuredClone() drops it, which
  // is harmless because toAscii() also has its own default.
  Object.defineProperty(matrix, 'border', {
    value: border,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return matrix;
}

/**
 * Render a matrix as a multi-line ASCII/Unicode block string for terminals and
 * log-based self-tests.
 *
 * @param {{ size: number, modules: boolean[][] }} matrix - Result of createQrMatrix().
 * @param {{ border?: number, dark?: string, light?: string }} [options]
 *   border - quiet-zone width in modules; defaults to the non-enumerable
 *            `matrix.border` hint from createQrMatrix(), else 2.
 *   dark   - string used per dark module, default '██'.
 *   light  - string used per light module, default '  '.
 * @returns {string} Multi-line rendering (no trailing newline).
 * @throws {TypeError} matrix/options/dark/light are invalid.
 * @throws {RangeError} border is out of range.
 */
export function toAscii(matrix, options) {
  const { size, modules } = assertMatrix(matrix, 'toAscii');

  const opts = readOptions(options, 'toAscii');
  const hint = Number.isInteger(matrix.border) ? matrix.border : 2;
  const border = readBorder(opts.border, 'toAscii', hint);
  const dark = readCellString(opts.dark, 'dark', DEFAULT_ASCII_DARK, 'toAscii');
  const light = readCellString(opts.light, 'light', DEFAULT_ASCII_LIGHT, 'toAscii');

  const blank = light.repeat(size + 2 * border);
  const lines = [];

  for (let i = 0; i < border; i += 1) lines.push(blank);
  for (let row = 0; row < size; row += 1) {
    const line = modules[row];
    let text = light.repeat(border);
    for (let col = 0; col < size; col += 1) {
      text += line[col] ? dark : light;
    }
    text += light.repeat(border);
    lines.push(text);
  }
  for (let i = 0; i < border; i += 1) lines.push(blank);

  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* internal validation helpers                                               */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} options
 * @param {string} fnName
 * @returns {Record<string, unknown>}
 */
function readOptions(options, fnName) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${fnName}: options must be a plain object when provided`);
  }
  return /** @type {Record<string, unknown>} */ (options);
}

/**
 * @param {unknown} value
 * @param {string} fnName
 * @returns {'L'|'M'|'Q'|'H'}
 */
function readEcc(value, fnName) {
  if (value === undefined) return DEFAULT_ECC;
  if (typeof value !== 'string') {
    throw new TypeError(`${fnName}: options.ecc must be one of 'L', 'M', 'Q', 'H'`);
  }
  const ecc = value.toUpperCase();
  if (!ECC_LEVELS.includes(ecc)) {
    throw new RangeError(
      `${fnName}: invalid ecc ${JSON.stringify(value)}; expected one of 'L', 'M', 'Q', 'H'`,
    );
  }
  return ecc;
}

/**
 * @param {unknown} value
 * @param {string} fnName
 * @param {number} fallback
 * @returns {number}
 */
function readBorder(value, fnName, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BORDER) {
    throw new RangeError(`${fnName}: options.border must be an integer between 0 and ${MAX_BORDER}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {string} fallback
 * @param {string} fnName
 * @returns {string}
 */
function readCellString(value, name, fallback, fnName) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fnName}: options.${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a matrix argument without trusting any of its fields.
 *
 * @param {unknown} matrix
 * @param {string} fnName
 * @returns {{ size: number, modules: boolean[][] }}
 */
function assertMatrix(matrix, fnName) {
  if (matrix === null || typeof matrix !== 'object') {
    throw new TypeError(`${fnName}: matrix must be the object returned by createQrMatrix`);
  }
  const { size, modules } = /** @type {any} */ (matrix);

  if (!Number.isInteger(size) || size < 21 || size > 177 || (size - 17) % 4 !== 0) {
    throw new TypeError(`${fnName}: matrix.size must be a valid QR module count (21..177, step 4)`);
  }
  if (!Array.isArray(modules) || modules.length !== size) {
    throw new TypeError(`${fnName}: matrix.modules must be an array of ${size} rows`);
  }
  for (let row = 0; row < size; row += 1) {
    const line = modules[row];
    if (!Array.isArray(line) || line.length !== size) {
      throw new TypeError(`${fnName}: matrix.modules[${row}] must be an array of ${size} booleans`);
    }
    for (let col = 0; col < size; col += 1) {
      if (typeof line[col] !== 'boolean') {
        throw new TypeError(`${fnName}: matrix.modules[${row}][${col}] must be a boolean`);
      }
    }
  }
  return { size, modules /** @type {boolean[][]} */ };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
