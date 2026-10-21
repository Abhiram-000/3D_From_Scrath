/**
 * The share dialog's QR code: a real ISO/IEC 18004 encoder, byte mode, level M, versions 1–10.
 *
 * WHY THIS FILE EXISTS
 * `00-GOAL.md` requires sharing "via link + QR code", and an earlier build drew a *decorative*
 * pattern — pseudo-random cells with finder-pattern corners — behind the same label. A control that
 * looks like it works and silently carries no data is worse than an absent one: the learner points a
 * phone at it, gets nothing, and cannot tell whether the phone or the app is at fault. This file
 * encodes the URL for real, or returns `null` so the caller can say so honestly.
 *
 * SCOPE
 * Byte mode, versions 1–10, error-correction level M: up to about 213 bytes of payload, which covers
 * the `?model=<uuid>` share link with room to spare. Level M is the standard balance for
 * screen-displayed codes. The narrow public surface is `encodeQr` (a boolean module matrix) plus
 * `qrPixelSize` / `drawQr` for rendering it; everything else is private so the encoding cannot be
 * half-used.
 *
 * HOW IT WORKS — the four stages of the specification, in order:
 *  1. Data encoding: mode indicator, character count, payload, terminator, pad codewords, sized to
 *     the smallest version that fits.
 *  2. Error correction: Reed–Solomon over GF(256) with the primitive polynomial x^8+x^4+x^3+x^2+1
 *     (0x11d), producing each block's parity codewords.
 *  3. Structure: codewords interleaved across blocks, then placed along the standard boustrophedon
 *     path around the finder, timing, alignment and format/version patterns.
 *  4. Masking: all eight mask patterns are generated and scored with the four penalty rules from the
 *     specification; the lowest penalty wins. Masking is what stops the data from forging regions a
 *     scanner would mistake for finder patterns.
 *
 * Correctness is pinned by `qr.test.ts`, whose cross-check values come from an independent encoder
 * (see that file), not from this implementation re-deriving its own expectations.
 */

/** Error-correction level M's two-bit indicator in the format information (ISO/IEC 18004 Table 25). */
const EC_LEVEL_M = 0b00;

/** A working matrix: `-1` = not yet decided, `0` = light, `1` = dark. */
type Grid = number[][];

/**
 * Per-version parameters for level M.
 *
 * `groups` holds each block group as `[blocks, dataCodewordsPerBlock]`; group 2 is empty for
 * versions 1–7, which is how QR balances block sizes that differ by one codeword at higher versions.
 * `ecPerBlock` is the Reed–Solomon parity length, identical for every block of a version.
 */
interface VersionSpec {
  ecPerBlock: number;
  groups: readonly (readonly [blocks: number, dataCodewords: number])[];
}

const VERSION_M = new Map<number, VersionSpec>([
  [1, { ecPerBlock: 10, groups: [[1, 16]] }],
  [2, { ecPerBlock: 16, groups: [[1, 28]] }],
  [3, { ecPerBlock: 26, groups: [[1, 44]] }],
  [4, { ecPerBlock: 18, groups: [[2, 32]] }],
  [5, { ecPerBlock: 24, groups: [[2, 43]] }],
  [6, { ecPerBlock: 16, groups: [[4, 27]] }],
  [7, { ecPerBlock: 18, groups: [[4, 31]] }],
  [
    8,
    {
      ecPerBlock: 22,
      groups: [
        [2, 38],
        [2, 39],
      ],
    },
  ],
  [
    9,
    {
      ecPerBlock: 22,
      groups: [
        [3, 36],
        [2, 37],
      ],
    },
  ],
  [
    10,
    {
      ecPerBlock: 26,
      groups: [
        [4, 43],
        [1, 44],
      ],
    },
  ],
]);

/** Alignment-pattern centre coordinates per version (the finder-adjacent ones are skipped at read). */
const ALIGNMENT_CENTRES = new Map<number, readonly number[]>([
  [1, []],
  [2, [6, 18]],
  [3, [6, 22]],
  [4, [6, 26]],
  [5, [6, 30]],
  [6, [6, 34]],
  [7, [6, 22, 38]],
  [8, [6, 24, 42]],
  [9, [6, 26, 46]],
  [10, [6, 28, 50]],
]);

/**
 * Version-information bit strings for versions 7–10.
 *
 * Versions 7 and up carry an 18-bit BCH(18,6) block beside two finder patterns. It is mandatory: a
 * conforming scanner rejects a symbol that omits it, and no amount of correct data compensates.
 */
const VERSION_BITS = new Map<number, number>([
  [7, 0x07c94],
  [8, 0x085bc],
  [9, 0x09a99],
  [10, 0x0a4d3],
]);

/* ── Galois field GF(256) ─────────────────────────────────────────────────────
 * Reed–Solomon arithmetic is multiplication in this field. Precomputing exponent and logarithm
 * tables turns every multiply into two lookups and an addition.
 */

const GF_EXP: number[] = new Array<number>(512).fill(0);
const GF_LOG: number[] = new Array<number>(256).fill(0);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    // Reduce modulo the primitive polynomial 0x11d when the byte overflows.
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  // The second half of the exponent table lets a product of two logs index without a modulo.
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/** `a^i` in the field; callers here only ever pass small exponents. */
function gfPower(index: number): number {
  return GF_EXP[index] ?? 0;
}

/* ── Format information ─────────────────────────────────────────────────────── */

/** The 10-bit BCH generator (x^10+x^8+x^5+x^4+x^2+x+1) and the fixed mask the spec XORs in. */
const FORMAT_GENERATOR = 0b10100110111;
const FORMAT_MASK = 0b101010000010010;

/**
 * The 15-bit format information: five data bits (two for the EC level, three for the mask) followed
 * by a BCH(15,5) check, then XORed with the spec's fixed mask.
 *
 * Computed rather than table-copied so the value is auditable at the point of use; `qr.test.ts`
 * round-trips it back to the mask number.
 */
function formatBits(ecLevel: number, mask: number): number {
  const data = (ecLevel << 3) | mask;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (((remainder >> i) & 1) === 1) remainder ^= FORMAT_GENERATOR << (i - 10);
  }
  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

/* ── Grid access ────────────────────────────────────────────────────────────── */

function createGrid(size: number, fill: number): Grid {
  return Array.from({ length: size }, () => new Array<number>(size).fill(fill));
}

function at(grid: Grid, row: number, col: number): number {
  return grid[row]?.[col] ?? -1;
}

function put(grid: Grid, row: number, col: number, value: number): void {
  const line = grid[row];
  if (line !== undefined && col >= 0 && col < line.length) line[col] = value;
}

/* ── Reed–Solomon ───────────────────────────────────────────────────────────── */

/**
 * Generator polynomial for `degree` parity codewords, built as the product of (x − a^i).
 *
 * The coefficients are highest-degree first, and generator[0] is always 1 — `ecCodewords` relies on
 * that when it feeds the polynomial into the synthetic division below.
 */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      const coefficient = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(coefficient, gfPower(i));
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon parity codewords for one data block (synthetic division by the generator). */
function ecCodewords(data: readonly number[], count: number): number[] {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < count; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

/* ── Stage 1 + 2: bits, padding, blocks, interleaving ───────────────────────── */

/** UTF-8 bytes for the payload, so a multi-byte URL is measured by what the scanner will read. */
function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Total data codewords a version holds at level M. */
function dataCapacity(version: number): number | null {
  const spec = VERSION_M.get(version);
  if (spec === undefined) return null;
  return spec.groups.reduce((total, [blocks, codewords]) => total + blocks * codewords, 0);
}

/** Smallest version that can hold `byteLength` payload bytes in byte mode, or null past version 10. */
function chooseVersion(byteLength: number): number | null {
  for (let version = 1; version <= 10; version++) {
    const capacity = dataCapacity(version);
    if (capacity === null) continue;
    // 4 bits of mode + the character count + the payload itself.
    const lengthBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lengthBits + byteLength * 8) / 8);
    if (needed <= capacity) return version;
  }
  return null;
}

/** The final interleaved codeword sequence: data blocks interleaved, then parity blocks. */
function buildCodewords(bytes: readonly number[], version: number, spec: VersionSpec): number[] {
  const capacity = dataCapacity(version) ?? 0;
  const lengthBits = version < 10 ? 8 : 16;

  const bits: number[] = [];
  const pushBits = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, lengthBits);
  for (const byte of bytes) pushBits(byte, 8);

  // Terminator: up to four zero bits, but never past capacity.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  // Pad to a byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    data.push(byte);
  }

  // Pad codewords alternate 0xEC / 0x11, exactly as the specification requires.
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < capacity; i++) data.push(pads[i % 2] ?? 0xec);

  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [blockCount, dataCount] of spec.groups) {
    for (let i = 0; i < blockCount; i++) {
      const blockData = data.slice(offset, offset + dataCount);
      offset += dataCount;
      blocks.push({ data: blockData, ec: ecCodewords(blockData, spec.ecPerBlock) });
    }
  }

  // Interleaving spreads a physical smudge across several blocks, so each block loses only a few
  // symbols and stays correctable. Shorter blocks simply skipped a round.
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      const value = block.data[i];
      if (value !== undefined) result.push(value);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of blocks) result.push(block.ec[i] ?? 0);
  }
  return result;
}

/* ── Stage 3: function patterns ─────────────────────────────────────────────── */

/**
 * A finder pattern and its separator: a 7x7 dark/light/dark bullseye, with the row and column one
 * module outside it (the `dr`/`dc` = -1 or 7 ring) left light. `put` drops the cells that fall off
 * the grid at the two edge finders.
 */
function placeFinder(grid: Grid, row: number, col: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const onBorder = (dr === 0 || dr === 6) && dc >= 0 && dc <= 6;
      const onSide = (dc === 0 || dc === 6) && dr >= 0 && dr <= 6;
      const inCentre = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      put(grid, row + dr, col + dc, onBorder || onSide || inCentre ? 1 : 0);
    }
  }
}

function placeAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT_CENTRES.get(version) ?? [];
  const size = grid.length;
  for (const row of centres) {
    for (const col of centres) {
      // Skip the three positions the finder patterns already occupy.
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          put(grid, row + dr, col + dc, dark ? 1 : 0);
        }
      }
    }
  }
}

function placeTiming(grid: Grid): void {
  const size = grid.length;
  for (let i = 8; i < size - 8; i++) {
    const value = i % 2 === 0 ? 1 : 0;
    if (at(grid, 6, i) === -1) put(grid, 6, i, value);
    if (at(grid, i, 6) === -1) put(grid, i, 6, value);
  }
}

/** Reserve the format-information areas (and the always-dark module) before data placement. */
function reserveFormatAreas(grid: Grid): void {
  const size = grid.length;
  for (let i = 0; i < 9; i++) {
    if (at(grid, 8, i) === -1) put(grid, 8, i, 0);
    if (at(grid, i, 8) === -1) put(grid, i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (at(grid, 8, size - 1 - i) === -1) put(grid, 8, size - 1 - i, 0);
    if (at(grid, size - 1 - i, 8) === -1) put(grid, size - 1 - i, 8, 0);
  }
  // The dark module, always 1.
  put(grid, size - 8, 8, 1);
}

/** Reserve the two 3x6 version-information blocks for versions 7 and above. */
function reserveVersionAreas(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    if (at(grid, size - 11 + col, row) === -1) put(grid, size - 11 + col, row, 0);
    if (at(grid, row, size - 11 + col) === -1) put(grid, row, size - 11 + col, 0);
  }
}

function placeVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = VERSION_BITS.get(version);
  if (bits === undefined) return;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    put(grid, size - 11 + col, row, bit);
    put(grid, row, size - 11 + col, bit);
  }
}

/**
 * Write the format information twice, for redundancy near two of the finder patterns.
 *
 * Copy 1 runs down column 8 (bits 0–5, then 6 and 7 skipping the timing row) and turns the corner
 * across row 8 (bit 8, then bits 9–14 back towards the left). Copy 2 mirrors it: bits 0–7 across row
 * 8 to the top-right finder, bits 8–14 down column 8 to the bottom-left. The axes matter — a
 * transposed pair is still self-consistent, which is exactly why this is pinned by a decoded test.
 */
function placeFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatBits(EC_LEVEL_M, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;

    // Copy 1: around the top-left finder.
    if (i < 6) put(grid, i, 8, bit);
    else if (i === 6) put(grid, 7, 8, bit);
    else if (i === 7) put(grid, 8, 8, bit);
    else if (i === 8) put(grid, 8, 7, bit);
    else put(grid, 8, 14 - i, bit);

    // Copy 2: split between the top-right and bottom-left finders.
    if (i < 8) put(grid, 8, size - 1 - i, bit);
    else put(grid, size - 15 + i, 8, bit);
  }
}

/* ── Stage 3: data placement ────────────────────────────────────────────────── */

/**
 * Place the data bits along the standard zig-zag: two columns at a time, right to left, alternating
 * up and down, skipping the vertical timing column and every reserved module.
 */
function placeData(
  grid: Grid,
  codewords: readonly number[],
  reserved: readonly (readonly boolean[])[],
): void {
  const size = grid.length;
  let bitIndex = 0;
  let upward = true;

  const bitAt = (index: number): number => {
    const byte = codewords[index >> 3];
    if (byte === undefined) return 0;
    return (byte >> (7 - (index & 7))) & 1;
  };

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const x = col - offset;
        if (reserved[row]?.[x] === true) continue;
        put(grid, row, x, bitAt(bitIndex++));
      }
    }
    upward = !upward;
  }
}

/* ── Stage 4: masking ───────────────────────────────────────────────────────── */

/** The eight mask conditions, by pattern number. */
const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

/** Apply a mask to the data modules only — never to function patterns. */
function applyMask(grid: Grid, reserved: readonly (readonly boolean[])[], mask: number): void {
  const condition = MASKS[mask];
  if (condition === undefined) return;
  const size = grid.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (reserved[row]?.[col] === true) continue;
      if (condition(row, col)) put(grid, row, col, at(grid, row, col) ^ 1);
    }
  }
}

/** Whether `pattern` occurs in a row or column starting at (`row`, `col`), reading the given axis. */
function matchesPattern(
  grid: Grid,
  row: number,
  col: number,
  horizontal: boolean,
  pattern: readonly number[],
): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const value = horizontal ? at(grid, row, col + i) : at(grid, col + i, row);
    if (value !== pattern[i]) return false;
  }
  return true;
}

/**
 * Score a candidate with the specification's four penalty rules. Lower is better: each rule
 * penalises exactly the features that confuse a scanner.
 */
function penaltyScore(grid: Grid): number {
  const size = grid.length;
  let penalty = 0;

  // Rule 1: runs of five or more same-coloured modules. A run of length L costs 3 + (L - 5).
  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < size; j++) {
      if (at(grid, i, j) === at(grid, i, j - 1)) rowRun++;
      else {
        if (rowRun >= 5) penalty += rowRun - 2;
        rowRun = 1;
      }
      if (at(grid, j, i) === at(grid, j - 1, i)) colRun++;
      else {
        if (colRun >= 5) penalty += colRun - 2;
        colRun = 1;
      }
    }
    if (rowRun >= 5) penalty += rowRun - 2;
    if (colRun >= 5) penalty += colRun - 2;
  }

  // Rule 2: every 2x2 block of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = at(grid, row, col);
      if (
        value === at(grid, row, col + 1) &&
        value === at(grid, row + 1, col) &&
        value === at(grid, row + 1, col + 1)
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules on either side, which a
  // scanner could mistake for a real finder pattern.
  const finderLike = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reverseFinderLike = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (
        matchesPattern(grid, i, j, true, finderLike) ||
        matchesPattern(grid, i, j, true, reverseFinderLike)
      ) {
        penalty += 40;
      }
      if (
        matchesPattern(grid, i, j, false, finderLike) ||
        matchesPattern(grid, i, j, false, reverseFinderLike)
      ) {
        penalty += 40;
      }
    }
  }

  // Rule 4: deviation from a 50% dark ratio, in 5% steps.
  let dark = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) if (at(grid, row, col) === 1) dark++;
  }
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

/* ── Public surface ─────────────────────────────────────────────────────────── */

/**
 * An encoded symbol: the chosen version and mask, the module count, and the row-major modules
 * (`true` = dark). `readonly` on purpose — the matrix is a value, not a scratch buffer.
 */
export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * Encode `text` (UTF-8, byte mode, level M) as a QR module matrix.
 *
 * Returns `null` — never a broken symbol — when there is nothing to encode or the payload does not
 * fit version 10 at level M. Callers must say so rather than draw an empty canvas.
 */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = utf8Bytes(text);
  if (bytes.length === 0) return null;

  const version = chooseVersion(bytes.length);
  if (version === null) return null;
  const spec = VERSION_M.get(version);
  if (spec === undefined) return null;

  const size = 17 + version * 4;
  const codewords = buildCodewords(bytes, version, spec);

  // Function patterns are identical for every mask, so they are placed once and the reserved map is
  // captured before any data — the mask loop can then re-place data cheaply and correctly.
  const base = createGrid(size, -1);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTiming(base);
  reserveFormatAreas(base);
  reserveVersionAreas(base, version);

  const reserved = base.map((line) => line.map((cell) => cell !== -1));

  let best: { penalty: number; modules: Grid; mask: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((line) => [...line]);
    placeData(candidate, codewords, reserved);
    applyMask(candidate, reserved, mask);
    placeFormat(candidate, mask);
    placeVersionInfo(candidate, version);

    const penalty = penaltyScore(candidate);
    // Strict `<` keeps the lowest mask number on a tie, which is what the cross-check encoder does.
    if (best === null || penalty < best.penalty) best = { penalty, modules: candidate, mask };
  }
  // All eight masks were tried, so `best` is set; the guard exists for the type system, not for a
  // runtime case a caller could ever hit, and a null here would be encoded as "unavailable".
  if (best === null) return null;

  return {
    version,
    size,
    mask: best.mask,
    modules: best.modules.map((line) => line.map((cell) => cell === 1)),
  };
}

/** The slice of a `CanvasRenderingContext2D` this file needs — enough to draw, nothing more. */
export interface QrDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, width: number, height: number): void;
}

export interface QrDrawOptions {
  /** Pixels per module; an integer keeps every module crisp. Default 4. */
  moduleSize?: number;
  /** Quiet zone in modules. Default 4 — the specification's minimum, which scanners need. */
  quietZone?: number;
  dark?: string;
  light?: string;
}

/** The pixel dimension a drawn symbol occupies, so the caller can size its canvas first. */
export function qrPixelSize(matrix: QrMatrix, moduleSize = 4, quietZone = 4): number {
  return (matrix.size + quietZone * 2) * moduleSize;
}

/**
 * Draw `matrix` into `context`, filling the light background and every dark module.
 *
 * Deliberately takes a context rather than an element or `ImageData`: sizing the canvas stays with
 * the caller (see `qrPixelSize`), and nothing here touches a DOM node it did not receive. Returns
 * the pixel dimension drawn.
 */
export function drawQr(
  context: QrDrawContext,
  matrix: QrMatrix,
  options: QrDrawOptions = {},
): number {
  const moduleSize = options.moduleSize ?? 4;
  const quietZone = options.quietZone ?? 4;
  const dimension = qrPixelSize(matrix, moduleSize, quietZone);

  context.fillStyle = options.light ?? '#ffffff';
  context.fillRect(0, 0, dimension, dimension);

  context.fillStyle = options.dark ?? '#0f172a';
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.modules[row]?.[col] !== true) continue;
      context.fillRect(
        (col + quietZone) * moduleSize,
        (row + quietZone) * moduleSize,
        moduleSize,
        moduleSize,
      );
    }
  }
  return dimension;
}
