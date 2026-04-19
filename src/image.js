// Small helpers for moving between our Float32 RGB buffer (width*height*3,
// values in [0,1]) and a browser ImageData (Uint8ClampedArray RGBA).

export function floatRgbToImageData(rgb, width, height) {
  const img = new ImageData(width, height)
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    img.data[j]     = Math.round(clamp01(rgb[i * 3])     * 255)
    img.data[j + 1] = Math.round(clamp01(rgb[i * 3 + 1]) * 255)
    img.data[j + 2] = Math.round(clamp01(rgb[i * 3 + 2]) * 255)
    img.data[j + 3] = 255
  }
  return img
}

export function psnrDb(a, b) {
  if (a.length !== b.length) throw new Error('length mismatch')
  let sumSq = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sumSq += d * d
  }
  const mse = sumSq / a.length
  return mse === 0 ? Infinity : 10 * Math.log10(1 / mse)
}

// Horizontally-margined PSNR, excluding `marginX` pixels on each side of
// the image (useful for skipping cross-luminance at colour-bar edges).
export function psnrDbWithMargin(a, b, width, height, marginX, channels = 3) {
  let sumSq = 0, n = 0
  for (let y = 0; y < height; y++) {
    for (let x = marginX; x < width - marginX; x++) {
      for (let c = 0; c < channels; c++) {
        const o = (y * width + x) * channels + c
        const d = a[o] - b[o]
        sumSq += d * d
        n++
      }
    }
  }
  return sumSq === 0 ? Infinity : 10 * Math.log10(1 / (sumSq / n))
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
