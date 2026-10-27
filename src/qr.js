/**
 * ساخت QR کد داخل خود Worker (بدون سرویس بیرونی و بدون وابستگی).
 * لینک اشتراک مثل رمز عبوره؛ برای همین QR رو با سرویس‌های آنلاین نمی‌سازیم.
 *
 * - حالت داده: بایت (UTF-8)
 * - سطح تصحیح خطا: L/M/Q/H؛ کوچک‌ترین نسخه‌ی ممکن (۱ تا ۴۰) انتخاب میشه
 * - خروجی: PNG تک‌بیتی (هر ماژول ۸×۸ پیکسل) با بلوک‌های deflate بدون فشرده‌سازی
 * - بهینه برای سقف CPU پلن رایگان Cloudflare (آرایه‌های تایپ‌شده، بدون حلقه روی پیکسل)
 */

// جدول بلوک‌های تصحیح خطا (ISO 18004): برای هر نسخه، سه‌تایی‌های [تعداد بلوک، کل کدورد هر بلوک، کدورد داده هر بلوک]
const RS_TABLE = {
  L: [[1,26,19],[1,44,34],[1,70,55],[1,100,80],[1,134,108],[2,86,68],[2,98,78],[2,121,97],[2,146,116],[2,86,68,2,87,69],[4,101,81],[2,116,92,2,117,93],[4,133,107],[3,145,115,1,146,116],[5,109,87,1,110,88],[5,122,98,1,123,99],[1,135,107,5,136,108],[5,150,120,1,151,121],[3,141,113,4,142,114],[3,135,107,5,136,108],[4,144,116,4,145,117],[2,139,111,7,140,112],[4,151,121,5,152,122],[6,147,117,4,148,118],[8,132,106,4,133,107],[10,142,114,2,143,115],[8,152,122,4,153,123],[3,147,117,10,148,118],[7,146,116,7,147,117],[5,145,115,10,146,116],[13,145,115,3,146,116],[17,145,115],[17,145,115,1,146,116],[13,145,115,6,146,116],[12,151,121,7,152,122],[6,151,121,14,152,122],[17,152,122,4,153,123],[4,152,122,18,153,123],[20,147,117,4,148,118],[19,148,118,6,149,119]],
  M: [[1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],[4,43,27],[4,49,31],[2,60,38,2,61,39],[3,58,36,2,59,37],[4,69,43,1,70,44],[1,80,50,4,81,51],[6,58,36,2,59,37],[8,59,37,1,60,38],[4,64,40,5,65,41],[5,65,41,5,66,42],[7,73,45,3,74,46],[10,74,46,1,75,47],[9,69,43,4,70,44],[3,70,44,11,71,45],[3,67,41,13,68,42],[17,68,42],[17,74,46],[4,75,47,14,76,48],[6,73,45,14,74,46],[8,75,47,13,76,48],[19,74,46,4,75,47],[22,73,45,3,74,46],[3,73,45,23,74,46],[21,73,45,7,74,46],[19,75,47,10,76,48],[2,74,46,29,75,47],[10,74,46,23,75,47],[14,74,46,21,75,47],[14,74,46,23,75,47],[12,75,47,26,76,48],[6,75,47,34,76,48],[29,74,46,14,75,47],[13,74,46,32,75,47],[40,75,47,7,76,48],[18,75,47,31,76,48]],
  Q: [[1,26,13],[1,44,22],[2,35,17],[2,50,24],[2,33,15,2,34,16],[4,43,19],[2,32,14,4,33,15],[4,40,18,2,41,19],[4,36,16,4,37,17],[6,43,19,2,44,20],[4,50,22,4,51,23],[4,46,20,6,47,21],[8,44,20,4,45,21],[11,36,16,5,37,17],[5,54,24,7,55,25],[15,43,19,2,44,20],[1,50,22,15,51,23],[17,50,22,1,51,23],[17,47,21,4,48,22],[15,54,24,5,55,25],[17,50,22,6,51,23],[7,54,24,16,55,25],[11,54,24,14,55,25],[11,54,24,16,55,25],[7,54,24,22,55,25],[28,50,22,6,51,23],[8,53,23,26,54,24],[4,54,24,31,55,25],[1,53,23,37,54,24],[15,54,24,25,55,25],[42,54,24,1,55,25],[10,54,24,35,55,25],[29,54,24,19,55,25],[44,54,24,7,55,25],[39,54,24,14,55,25],[46,54,24,10,55,25],[49,54,24,10,55,25],[48,54,24,14,55,25],[43,54,24,22,55,25],[34,54,24,34,55,25]],
  H: [[1,26,9],[1,44,16],[2,35,13],[4,25,9],[2,33,11,2,34,12],[4,43,15],[4,39,13,1,40,14],[4,40,14,2,41,15],[4,36,12,4,37,13],[6,43,15,2,44,16],[3,36,12,8,37,13],[7,42,14,4,43,15],[12,33,11,4,34,12],[11,36,12,5,37,13],[11,36,12,7,37,13],[3,45,15,13,46,16],[2,42,14,17,43,15],[2,42,14,19,43,15],[9,39,13,16,40,14],[15,43,15,10,44,16],[19,46,16,6,47,17],[34,37,13],[16,45,15,14,46,16],[30,46,16,2,47,17],[22,45,15,13,46,16],[33,46,16,4,47,17],[12,45,15,28,46,16],[11,45,15,31,46,16],[19,45,15,26,46,16],[23,45,15,25,46,16],[23,45,15,28,46,16],[19,45,15,35,46,16],[11,45,15,46,46,16],[59,46,16,1,47,17],[22,45,15,41,46,16],[2,45,15,64,46,16],[24,45,15,46,46,16],[42,45,15,32,46,16],[10,45,15,67,46,16],[20,45,15,61,46,16]],
};

const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // بیت‌های فرمت

function blockGroups(version, ecc) {
  const flat = RS_TABLE[ecc][version - 1];
  const groups = [];
  for (let i = 0; i < flat.length; i += 3) groups.push({ count: flat[i], total: flat[i + 1], data: flat[i + 2] });
  return groups;
}
const dataCodewords = (version, ecc) => blockGroups(version, ecc).reduce((s, g) => s + g.count * g.data, 0);

// ---------- میدان گالوا GF(256) (جدول لگاریتم) و Reed-Solomon ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
function rsGenerator(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}
const genCache = new Map();
function rsRemainder(data, degree) {
  let divisor = genCache.get(degree);
  if (!divisor) genCache.set(degree, (divisor = rsGenerator(degree)));
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    if (factor) for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (((x / 3) | 0) + ((y / 2) | 0)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** ماتریس QR رو می‌سازه: { size, version, mask, get(x,y) } */
export function qrMatrix(text, ecc = "M") {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (headerBits + bytes.length * 8 <= dataCodewords(v, ecc) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("متن برای QR خیلی بلنده");
  const size = version * 4 + 17;

  // --- بیت‌های داده ---
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const dataCw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    dataCw.push(v);
  }

  // --- بلوک‌ها + تصحیح خطا + درهم‌ریزی ---
  const blocks = [];
  let k = 0;
  for (const g of blockGroups(version, ecc)) {
    for (let i = 0; i < g.count; i++) {
      const d = dataCw.slice(k, k + g.data);
      k += g.data;
      blocks.push({ data: d, ecc: rsRemainder(d, g.total - g.data) });
    }
  }
  const all = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) all.push(b.data[i]);
  const maxEcc = Math.max(...blocks.map((b) => b.ecc.length));
  for (let i = 0; i < maxEcc; i++) for (const b of blocks) if (i < b.ecc.length) all.push(b.ecc[i]);

  // --- ماتریس (آرایه‌ی تخت) ---
  const mod = new Uint8Array(size * size);
  const isFn = new Uint8Array(size * size);
  const setFn = (x, y, dark) => {
    mod[y * size + x] = dark ? 1 : 0;
    isFn[y * size + x] = 1;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = alignmentPositions(version, size);
  for (let i = 0; i < ap.length; i++) {
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const data = (ECC_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fb = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fb, i));
    setFn(8, 7, getBit(fb, 6));
    setFn(8, 8, getBit(fb, 7));
    setFn(7, 8, getBit(fb, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(fb, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(fb, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(fb, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(vb, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // --- جاگذاری کدوردها (زیگزاگ) ---
  let bi = 0;
  const totalBits = all.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y * size + x] && bi < totalBits) {
          mod[y * size + x] = (all[bi >>> 3] >>> (7 - (bi & 7))) & 1;
          bi++;
        }
      }
    }
  }

  // --- انتخاب بهترین ماسک ---
  const applyMask = (m) => {
    const f = MASKS[m];
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) if (!isFn[row + x] && f(x, y)) mod[row + x] ^= 1;
    }
  };
  // الگوی شبه‌finder: 1011101 با ۴ ماژول روشن در یک طرف
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const penalty = () => {
    let result = 0;
    for (const [sa, sb] of [[size, 1], [1, size]]) {
      for (let a = 0; a < size; a++) {
        const base = a * sa;
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (mod[base + b * sb] === mod[base + (b - 1) * sb]) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else run = 1;
        }
        for (let b = 0; b + 7 <= size; b++) {
          let ok = true;
          for (let i = 0; i < 7; i++) {
            if (mod[base + (b + i) * sb] !== PAT[i]) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          let before = true;
          for (let d = 1; d <= 4; d++) if (b - d >= 0 && mod[base + (b - d) * sb]) before = false;
          let after = true;
          for (let d = 0; d < 4; d++) if (b + 7 + d < size && mod[base + (b + 7 + d) * sb]) after = false;
          if (before || after) result += 40;
        }
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const i = y * size + x;
        const c = mod[i];
        if (c === mod[i + 1] && c === mod[i + size] && c === mod[i + size + 1]) result += 3;
      }
    }
    let dark = 0;
    for (let i = 0; i < mod.length; i++) dark += mod[i];
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  };
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const p = penalty();
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = m;
    }
    applyMask(m); // برگردوندن
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return { size, version, mask: bestMask, get: (x, y) => mod[y * size + x] === 1 };
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; ) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function put32(arr, off, n) {
  arr[off] = (n >>> 24) & 255;
  arr[off + 1] = (n >>> 16) & 255;
  arr[off + 2] = (n >>> 8) & 255;
  arr[off + 3] = n & 255;
}
function writeChunk(out, off, type, data) {
  put32(out, off, data.length);
  for (let i = 0; i < 4; i++) out[off + 4 + i] = type.charCodeAt(i);
  out.set(data, off + 8);
  put32(out, off + 8 + data.length, crc32(out, off + 4, off + 8 + data.length));
  return off + 12 + data.length;
}

/** متن رو به PNG (Uint8Array) تبدیل می‌کنه. هر ماژول ۸×۸ پیکسل (یعنی هر ماژول دقیقا یک بایت). */
export function qrPng(text, { ecc = "M", border = 4 } = {}) {
  let m;
  try {
    m = qrMatrix(text, ecc);
  } catch (e) {
    if (ecc === "M") m = qrMatrix(text, "L");
    else throw e;
  }
  const modules = m.size + border * 2;
  const dim = modules * 8;
  const rowBytes = modules; // دقیقا ۸ پیکسل = ۱ بایت برای هر ماژول
  const raw = new Uint8Array((rowBytes + 1) * dim);
  const row = new Uint8Array(rowBytes);
  for (let my = 0; my < modules; my++) {
    row.fill(0xff);
    const qy = my - border;
    if (qy >= 0 && qy < m.size) for (let qx = 0; qx < m.size; qx++) if (m.get(qx, qy)) row[qx + border] = 0x00;
    for (let k = 0; k < 8; k++) {
      const off = (my * 8 + k) * (rowBytes + 1);
      raw[off] = 0; // filter: none
      raw.set(row, off + 1);
    }
  }
  // zlib با بلوک‌های stored
  const nBlocks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + nBlocks * 5 + raw.length + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let zo = 2;
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    z[zo++] = i + len >= raw.length ? 1 : 0;
    z[zo++] = len & 255;
    z[zo++] = len >>> 8;
    z[zo++] = ~len & 255;
    z[zo++] = (~len >>> 8) & 255;
    z.set(raw.subarray(i, i + len), zo);
    zo += len;
  }
  put32(z, zo, adler32(raw));
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, dim);
  put32(ihdr, 4, dim);
  ihdr[8] = 1; // عمق بیت
  ihdr[9] = 0; // خاکستری
  const out = new Uint8Array(8 + (12 + 13) + (12 + z.length) + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let off = 8;
  off = writeChunk(out, off, "IHDR", ihdr);
  off = writeChunk(out, off, "IDAT", z);
  writeChunk(out, off, "IEND", new Uint8Array(0));
  return out;
}
