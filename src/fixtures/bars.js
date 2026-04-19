// 75% colour-bars fixture, all bars at 75% amplitude (SMPTE convention:
// "75/0/75/0" — white, colour bars, and the outer grey at 75%). This
// yields a smaller peak composite level (~0.525 V flat white) than the
// EBU "100/0/75/0" convention that HackTV's `test:colourbars` uses,
// where the white bar is at full 100%. Both are valid; this one gives
// more headroom in intermediate arithmetic and makes bar-level equality
// exact for all eight bars.
//
// Eight vertical bars, left-to-right: white, yellow, cyan, green, magenta,
// red, blue, black. Returned image is a flat Float32Array of length
// width*height*3, layout RGB row-major, top-to-bottom, values in [0, 1].

const BARS_75 = [
  [0.75, 0.75, 0.75], // white (75% grey, EBU convention)
  [0.75, 0.75, 0.00], // yellow
  [0.00, 0.75, 0.75], // cyan
  [0.00, 0.75, 0.00], // green
  [0.75, 0.00, 0.75], // magenta
  [0.75, 0.00, 0.00], // red
  [0.00, 0.00, 0.75], // blue
  [0.00, 0.00, 0.00], // black
]

export function colourBars75(width, height) {
  const out = new Float32Array(width * height * 3)
  for (let x = 0; x < width; x++) {
    const [r, g, b] = BARS_75[Math.floor((x * BARS_75.length) / width)]
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 3
      out[i    ] = r
      out[i + 1] = g
      out[i + 2] = b
    }
  }
  return out
}
