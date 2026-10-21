/**
 * The QR encoder's correctness, pinned to an outside reference.
 *
 * A QR code that looks right and carries nothing is the exact failure this module was written to
 * remove, so these tests do not merely re-assert the encoder's own output. They check the structural
 * invariants the specification fixes (finder patterns in three corners, alternating timing patterns,
 * the version-dependent module count, the BCH-checked format information) *and* compare the whole
 * module matrix against an independent encoder.
 *
 * The reference values below were produced with Python's `qrcode` package (the `qrcode.main.QRCode`
 * class with `error_correction=ERROR_CORRECT_M` and `add_data(..., optimize=0)` to force a single
 * byte-mode segment), which shares no code with this implementation:
 *
 *   >>> import qrcode
 *   >>> from qrcode.constants import ERROR_CORRECT_M
 *   >>> qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=1, border=0)
 *   >>> qr.add_data("Hello, world!", optimize=0); qr.make(fit=True)
 *   >>> qr.version, qr.modules_count, qr.best_mask_pattern()   # -> 1, 21, 2
 *
 * The `fnv1a` digest is over the row-major modules with dark = 1; a single flipped module changes it.
 */
import { describe, expect, it } from 'vitest';
import { drawQr, encodeQr, qrPixelSize, type QrMatrix } from './qr';

/** FNV-1a over the module bits, so the whole matrix can be compared as one value. */
function moduleDigest(matrix: QrMatrix): number {
  let hash = 0x811c9dc5;
  for (const row of matrix.modules) {
    for (const dark of row) {
      hash ^= dark ? 1 : 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

function darkCount(matrix: QrMatrix): number {
  let dark = 0;
  for (const row of matrix.modules) for (const cell of row) if (cell) dark++;
  return dark;
}

/** Decode the first copy of the format information back into its 15 raw bits (pre-XOR). */
function rawFormatBits(matrix: QrMatrix): number {
  const read = (row: number, col: number): number => (matrix.modules[row]?.[col] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let bit: number;
    if (i < 6) bit = read(i, 8);
    else if (i === 6) bit = read(7, 8);
    else if (i === 7) bit = read(8, 8);
    else if (i === 8) bit = read(8, 7);
    else bit = read(8, 14 - i);
    bits |= bit << i;
  }
  return bits;
}

/** Read the redundant second copy, so an inconsistent duplicate is caught rather than tolerated. */
function rawFormatBitsCopyTwo(matrix: QrMatrix): number {
  const size = matrix.size;
  const read = (row: number, col: number): number => (matrix.modules[row]?.[col] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 8 ? read(8, size - 1 - i) : read(size - 15 + i, 8);
    bits |= bit << i;
  }
  return bits;
}

/** The finder pattern plus separator at one corner: 7x7 bullseye, one light ring outside. */
function expectFinderPattern(matrix: QrMatrix, top: number, left: number): void {
  const read = (row: number, col: number): boolean => matrix.modules[row]?.[col] === true;
  for (let i = 0; i < 7; i++) {
    expect(read(top, left + i), `top border ${i}`).toBe(true);
    expect(read(top + 6, left + i), `bottom border ${i}`).toBe(true);
    expect(read(top + i, left), `left border ${i}`).toBe(true);
    expect(read(top + i, left + 6), `right border ${i}`).toBe(true);
  }
  for (let row = 1; row <= 5; row++) {
    for (let col = 1; col <= 5; col++) {
      expect(read(top + row, left + col) === (row >= 2 && row <= 4 && col >= 2 && col <= 4)).toBe(
        true,
      );
    }
  }
  // The separator ring is light.
  for (let i = 0; i <= 7; i++) {
    if (left + i < matrix.size) expect(read(top + 7, left + i)).toBe(false);
    if (top + i < matrix.size) expect(read(top + i, left + 7)).toBe(false);
  }
}

describe('encodeQr', () => {
  it('refuses what it cannot encode honestly', () => {
    expect(encodeQr('')).toBeNull();
    // 300 bytes exceeds version 10's ~213-byte ceiling at level M.
    expect(encodeQr('x'.repeat(300))).toBeNull();
  });

  it('matches an independent encoder for a short sample', () => {
    const matrix = encodeQr('Hello, world!');
    expect(matrix).not.toBeNull();
    // Cross-checked against Python `qrcode` with the commands in the file header.
    expect(matrix?.version).toBe(1);
    expect(matrix?.size).toBe(21);
    expect(matrix?.mask).toBe(2);
    expect(darkCount(matrix as QrMatrix)).toBe(232);
    expect(moduleDigest(matrix as QrMatrix)).toBe(0x9574789b);
  });

  it('matches an independent encoder for a realistic share URL', () => {
    const url = 'https://edu3d.example/viewer?model=7f9c2ba4-8e1d-4c3a-9b2e-1f0a6d5e4c3b';
    const matrix = encodeQr(url);
    expect(matrix).not.toBeNull();
    expect(matrix?.version).toBe(5);
    expect(matrix?.size).toBe(37);
    expect(matrix?.mask).toBe(2);
    expect(darkCount(matrix as QrMatrix)).toBe(696);
    expect(moduleDigest(matrix as QrMatrix)).toBe(0x39ec51d1);
  });

  // More coverage against the same reference: version 6 exercises four equal blocks, version 7 the
  // mandatory version-information block, and version 10 the 16-bit character count and the largest
  // block structure (four blocks of 43 plus one of 44).
  const moreSamples: ReadonlyArray<
    readonly [
      payload: string,
      version: number,
      size: number,
      mask: number,
      dark: number,
      digest: number,
    ]
  > = [
    ['q'.repeat(100), 6, 41, 0, 850, 0x19d58f65],
    ['q'.repeat(110), 7, 45, 7, 1048, 0x410e012d],
    ['q'.repeat(205), 10, 57, 1, 1569, 0x7924d33a],
  ];

  for (const [payload, version, size, mask, dark, digest] of moreSamples) {
    it(`matches an independent encoder for a ${payload.length}-byte payload (version ${version})`, () => {
      const matrix = encodeQr(payload) as QrMatrix;
      expect(matrix.version).toBe(version);
      expect(matrix.size).toBe(size);
      expect(matrix.mask).toBe(mask);
      expect(darkCount(matrix)).toBe(dark);
      expect(moduleDigest(matrix)).toBe(digest);
    });
  }
});

describe('the structural properties the specification fixes', () => {
  const samples = [
    encodeQr('Hello, world!') as QrMatrix,
    encodeQr('https://edu3d.example/viewer?model=7f9c2ba4-8e1d-4c3a-9b2e-1f0a6d5e4c3b') as QrMatrix,
  ];

  it('sizes the symbol as 21 + 4*(version - 1)', () => {
    for (const matrix of samples) {
      expect(matrix.size).toBe(21 + 4 * (matrix.version - 1));
      expect(matrix.modules).toHaveLength(matrix.size);
      for (const row of matrix.modules) expect(row).toHaveLength(matrix.size);
    }
  });

  it('puts finder patterns in the three corner positions', () => {
    for (const matrix of samples) {
      expectFinderPattern(matrix, 0, 0);
      expectFinderPattern(matrix, 0, matrix.size - 7);
      expectFinderPattern(matrix, matrix.size - 7, 0);
    }
  });

  it('alternates the timing patterns and marks the dark module', () => {
    for (const matrix of samples) {
      for (let i = 8; i < matrix.size - 8; i++) {
        const expected = i % 2 === 0;
        expect(matrix.modules[6]?.[i], `timing row at ${i}`).toBe(expected);
        expect(matrix.modules[i]?.[6], `timing column at ${i}`).toBe(expected);
      }
      expect(matrix.modules[matrix.size - 8]?.[8]).toBe(true);
    }
  });

  it('writes BCH-valid format information for level M, twice, matching the chosen mask', () => {
    for (const matrix of samples) {
      const raw = rawFormatBits(matrix);
      expect(rawFormatBitsCopyTwo(matrix)).toBe(raw);

      // Undo the spec's fixed XOR; the top five bits are the data (EC level << 3 | mask).
      const value = raw ^ 0b101010000010010;
      expect(value >> 10).toBe(matrix.mask); // EC level M is 0b00, so this is the mask alone.

      // The low ten bits must be a valid BCH(15,5) remainder.
      let remainder = value;
      for (let i = 14; i >= 10; i--) {
        if (((remainder >> i) & 1) === 1) remainder ^= 0b10100110111 << (i - 10);
      }
      expect(remainder).toBe(0);
    }
  });
});

describe('drawQr', () => {
  it('sizes to the quiet zone and paints only dark modules', () => {
    const matrix = encodeQr('Hello, world!') as QrMatrix;
    const calls: Array<{ x: number; y: number; w: number; h: number }> = [];
    let background = '';
    const context = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number): void {
        if (background === '' && this.fillStyle !== '#0f172a') background = String(this.fillStyle);
        calls.push({ x, y, w, h });
      },
    };

    const dimension = drawQr(context, matrix, { moduleSize: 4 });
    expect(dimension).toBe(qrPixelSize(matrix, 4));
    expect(dimension).toBe((matrix.size + 8) * 4);
    // One background fill plus one per dark module.
    expect(calls.length).toBe(darkCount(matrix) + 1);
    expect(background).toBe('#ffffff');
    // Modules are drawn inside the quiet zone.
    const firstModule = calls[1];
    expect(firstModule?.x).toBeGreaterThanOrEqual(16);
  });
});
