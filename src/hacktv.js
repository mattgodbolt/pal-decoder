// Loader for HackTV's baseband output.
//
// HackTV's `-m pal -o file:… -t int16` produces a stream of signed 16-bit
// samples at the requested sample rate. Sync tip sits at INT16_MIN *
// 0.3 ≈ -9830 and peak white at INT16_MAX * 0.7 ≈ 22937 — exactly our
// normalised IRE scale after dividing by 32767, so conversion is just
// a scale. Feed hacktv with `-s 17734475` to match our 4×Fsc pipeline
// and avoid any resampler dependency.

export const HACKTV_SCALE = 1 / 32767

/**
 * Convert an int16 buffer (Node Buffer, ArrayBuffer, or Int16Array) to a
 * Float32Array in our normalised scale. Assumes little-endian native;
 * HackTV and Node both run little-endian on x86/ARM.
 *
 * @param {Buffer|ArrayBuffer|Int16Array} src
 * @returns {Float32Array}
 */
export function int16ToFloat32(src) {
  let i16
  if (src instanceof Int16Array) {
    i16 = src
  } else if (src instanceof ArrayBuffer) {
    i16 = new Int16Array(src)
  } else if (ArrayBuffer.isView(src)) {
    // Node Buffer or other typed array -> reinterpret the underlying bytes.
    i16 = new Int16Array(src.buffer, src.byteOffset, src.byteLength >> 1)
  } else {
    throw new TypeError('expected Buffer, ArrayBuffer, or Int16Array')
  }
  const out = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] * HACKTV_SCALE
  return out
}
