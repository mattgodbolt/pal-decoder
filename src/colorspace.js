// RGB <-> Y'UV conversion (Rec. 601, the SD colour matrix PAL uses).
//
// Inputs and outputs are normalised floats:
//   R, G, B in [0, 1]
//   Y      in [0, 1]        (luma)
//   U, V   in [-Umax, Umax] / [-Vmax, Vmax]
//
// The U/V scaling factors come from the PAL requirement that the final
// modulated composite signal never exceed ~1.33 of peak luma. We use the
// classic coefficients:
//   U = 0.492 (B - Y)
//   V = 0.877 (R - Y)
// which give Umax = 0.436 and Vmax = 0.615 at primary colours.

export const KR = 0.299
export const KG = 0.587
export const KB = 0.114

export const U_SCALE = 0.492
export const V_SCALE = 0.877

export const U_MAX = U_SCALE * (1 - KB) // 0.436
export const V_MAX = V_SCALE * (1 - KR) // 0.615

export function rgbToYuv(r, g, b) {
  const y = KR * r + KG * g + KB * b
  const u = U_SCALE * (b - y)
  const v = V_SCALE * (r - y)
  return [y, u, v]
}

export function yuvToRgb(y, u, v) {
  const r = y + v / V_SCALE
  const b = y + u / U_SCALE
  const g = (y - KR * r - KB * b) / KG
  return [r, g, b]
}
