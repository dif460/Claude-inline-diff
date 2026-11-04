// Generates media/icon.png — an original icon for claude-inlineDiff.
// No dependencies: renders with 4x supersampling and encodes PNG via zlib.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 256;      // output size
const SS = 4;       // supersampling factor
const S = W * SS;   // render size

const buf = new Float32Array(S * S * 4); // straight RGBA

const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function blend(x, y, color, alpha) {
  if (alpha <= 0) return;
  const i = (y * S + x) * 4;
  const a = Math.min(1, alpha);
  const sa = a + buf[i + 3] * (1 - a);
  if (sa <= 0) return;
  for (let c = 0; c < 3; c++) {
    buf[i + c] = (color[c] * a + buf[i + c] * buf[i + 3] * (1 - a)) / sa;
  }
  buf[i + 3] = sa;
}

function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// colorFn(x, y) -> [r,g,b]
function roundedRect(x0, y0, x1, y1, r, colorFn, alpha = 1) {
  const X0 = Math.floor(x0 * SS), X1 = Math.ceil(x1 * SS);
  const Y0 = Math.floor(y0 * SS), Y1 = Math.ceil(y1 * SS);
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      if (insideRoundedRect(x + 0.5, y + 0.5, x0 * SS, y0 * SS, x1 * SS, y1 * SS, r * SS)) {
        blend(x, y, colorFn((x + 0.5) / SS, (y + 0.5) / SS), alpha);
      }
    }
  }
}

const solid = (r, g, b) => () => [r, g, b];

const lerp = (a, b, t) => a + (b - a) * t;

// ---- background: indigo -> violet diagonal gradient, rounded square ----
const c1 = hex('#6C5CE7');
const c2 = hex('#3B2BC7');
const c3 = hex('#2A1FA8');
roundedRect(10, 10, 246, 246, 58, (x, y) => {
  const t = Math.min(1, Math.max(0, (x + y) / (W * 2)));
  const u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
  const a = t < 0.55 ? c1 : c2;
  const b = t < 0.55 ? c2 : c3;
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
});

// ---- white code panel ----
roundedRect(46, 52, 210, 204, 26, solid(255, 255, 255), 0.97);

// ---- neutral line ----
roundedRect(70, 78, 170, 90, 6, solid(...hex('#B4BAD6')));

// ---- added line: green plus + light green bar ----
const green = hex('#1FA45B');
const greenLight = hex('#BFE9D2');
// plus
roundedRect(65, 112, 89, 122, 3, solid(...green));   // horizontal arm
roundedRect(72, 105, 82, 129, 3, solid(...green));   // vertical arm
roundedRect(104, 111, 186, 123, 6, solid(...greenLight));

// ---- removed line: red minus + light red bar ----
const red = hex('#D64545');
const redLight = hex('#F3C6C6');
roundedRect(65, 162, 89, 172, 3, solid(...red));     // minus
roundedRect(104, 161, 186, 173, 6, solid(...redLight));

// ---- downsample ----
const out = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        const al = buf[i + 3];
        r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al;
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 4;
    if (a > 0) {
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
}

// ---- PNG encode ----
const CRCTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRCTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(W, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) {
  raw[y * (W * 4 + 1)] = 0;
  out.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(dest, png);
console.log('wrote', dest, png.length, 'bytes');
