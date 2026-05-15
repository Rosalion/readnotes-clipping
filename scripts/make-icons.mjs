// 生成扩展图标（16/32/48/128 PNG），无第三方依赖。
// 设计：深森林绿圆角方块 + 一片奶油色叶子（中脉镂空）。
// "leaf" 一语双关 —— 既是森林的叶子，也是书的一"叶"。
// 运行：node scripts/make-icons.mjs
import zlib from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const SS = 4; // 超采样倍数，用于抗锯齿

// --- CRC32 ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- 调色 ---
const FOREST_TOP = [54, 92, 64]; // #365C40 顶部
const FOREST_BOT = [33, 61, 42]; // #213D2A 底部（轻微竖向渐变，增加体积感）
const LEAF = [243, 240, 228]; // #F3F0E4 奶油叶面
const STEM = [222, 217, 198]; // 叶柄，略深的奶油

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
function inRoundRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// 叶子几何参数（均为以画布中心为原点、半边长为 1 的归一化坐标）
const ANGLE = (-32 * Math.PI) / 180; // 叶子倾斜
const LEAF_LEN = 0.82; // 叶尖到叶基的半长
const LEAF_W = 0.30; // 叶最宽处的半宽
const VEIN = 0.045; // 中脉半宽
const STEM_LEN = 0.16; // 叶柄长度
const STEM_W = 0.035; // 叶柄半宽

function renderAt(size) {
  const S = size * SS;
  const px = Buffer.alloc(S * S * 4); // 全透明
  const r = S * 0.235;
  const cos = Math.cos(-ANGLE);
  const sin = Math.sin(-ANGLE);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRoundRect(x + 0.5, y + 0.5, S, S, r)) continue;

      // 背景：竖向渐变
      const ny = (y + 0.5) / S;
      let col = mix(FOREST_TOP, FOREST_BOT, ny);

      // 归一化到中心坐标 [-1,1]
      const ux = ((x + 0.5) / S) * 2 - 1;
      const uy = ((y + 0.5) / S) * 2 - 1;
      // 反向旋转到"叶子本地坐标"
      const lx = ux * cos - uy * sin;
      const lyRaw = ux * sin + uy * cos;
      const ly = lyRaw / LEAF_LEN; // ly ∈ [-1,1] 为叶身

      // 叶身：宽度沿长度抛物线收口，两端成尖
      if (ly >= -1 && ly <= 1) {
        const halfW = LEAF_W * (1 - ly * ly);
        if (Math.abs(lx) <= halfW) {
          // 中脉镂空（露出背景色），叶尖附近收窄
          const veinW = VEIN * (1 - 0.55 * Math.abs(ly));
          if (Math.abs(lx) > veinW) {
            // 叶面带极轻的明暗，靠近边缘略暗
            const edge = Math.abs(lx) / Math.max(halfW, 1e-6);
            col = mix(LEAF, FOREST_BOT, edge * 0.12);
          }
        }
      }

      // 叶柄：从叶基（ly≈1）继续向外延伸的小段
      if (lyRaw > LEAF_LEN && lyRaw < LEAF_LEN + STEM_LEN && Math.abs(lx) <= STEM_W) {
        col = STEM;
      }

      const i = (y * S + x) * 4;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }

  // 降采样（盒式平均）得到抗锯齿
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r2 = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          r2 += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r2 / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const buf = renderAt(size);
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), buf);
  console.log(`icons/icon${size}.png  ${buf.length} bytes`);
}
