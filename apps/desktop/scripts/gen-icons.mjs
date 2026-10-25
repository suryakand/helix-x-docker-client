#!/usr/bin/env node
// Renders the app icon (resources/icon.png, 1024x1024) with no external tools.
// electron-builder derives .icns (macOS) and .ico (Windows) from this PNG during packaging.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const SIZE = 1024
const px = new Uint8ClampedArray(SIZE * SIZE * 4)

// Signed distance to a rounded rectangle centred at (cx, cy).
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d))

function blend(i, r, g, b, a) {
  const da = px[i + 3] / 255
  const oa = a + da * (1 - a)
  if (oa === 0) return
  px[i] = (r * a + px[i] * da * (1 - a)) / oa
  px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa
  px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa
  px[i + 3] = oa * 255
}

const boxes = [
  // three stacked "containers"
  { cx: 512, cy: 352, hw: 250, hh: 82 },
  { cx: 512, cy: 532, hw: 250, hh: 82 },
  { cx: 512, cy: 712, hw: 250, hh: 82 }
]

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4
    // Background squircle with a diagonal blue → violet gradient (macOS icon grid: 824px body).
    const bg = cover(sdRoundRect(x + 0.5, y + 0.5, 512, 512, 412, 412, 184))
    if (bg > 0) {
      const t = (x + y) / (2 * SIZE)
      blend(i, 37 + (124 - 37) * t, 99 + (58 - 99) * t, 235 + (237 - 235) * t, bg)
    }
    for (const [k, b] of boxes.entries()) {
      const d = sdRoundRect(x + 0.5, y + 0.5, b.cx, b.cy, b.hw, b.hh, 34)
      const a = cover(d) * (k === 1 ? 1 : 0.88)
      if (a > 0) blend(i, 255, 255, 255, a)
      // a "port" dot on the left of each container
      const dot = cover(Math.hypot(x + 0.5 - (b.cx - 170), y + 0.5 - b.cy) - 26)
      if (dot > 0) blend(i, 59, 92, 236, dot)
    }
  }
}

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const out = resolve(import.meta.dirname, '..', 'resources')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png(SIZE, px))
console.log(`Wrote ${join(out, 'icon.png')}`)
