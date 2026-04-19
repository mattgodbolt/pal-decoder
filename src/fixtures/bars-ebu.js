// EBU "100/0/75/0" colour bars. White at 100% (0.7 V flat on our
// normalised composite scale), coloured bars at 75% amplitude, black
// at 0. This is what HackTV's `test:colourbars` emits.

const BARS_EBU = [
  [1.00, 1.00, 1.00], // white (100%)
  [0.75, 0.75, 0.00], // yellow
  [0.00, 0.75, 0.75], // cyan
  [0.00, 0.75, 0.00], // green
  [0.75, 0.00, 0.75], // magenta
  [0.75, 0.00, 0.00], // red
  [0.00, 0.00, 0.75], // blue
  [0.00, 0.00, 0.00], // black
]

export function colourBarsEbu(width, height) {
  const out = new Float32Array(width * height * 3)
  for (let x = 0; x < width; x++) {
    const [r, g, b] = BARS_EBU[Math.floor((x * BARS_EBU.length) / width)]
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3
      out[i    ] = r
      out[i + 1] = g
      out[i + 2] = b
    }
  }
  return out
}
