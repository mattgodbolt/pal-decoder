// Greyscale ramp: linear 0 → 1 across the image, constant vertically.
// Useful for checking luma linearity and spotting any colour cast
// introduced by the decoder on nominally-monochrome input.

export function greyRamp(width, height) {
  const out = new Float32Array(width * height * 3)
  for (let x = 0; x < width; x++) {
    const v = x / (width - 1)
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3
      out[i] = out[i + 1] = out[i + 2] = v
    }
  }
  return out
}
