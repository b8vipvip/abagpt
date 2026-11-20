// Guides describe the actual encoders used here, not a guessed upstream format.
// No generated payload, decoder implementation, or answer key is included.
export const decoderGuides = {
  loaf: `LoaF is one ASCII line: SHA256(-)=<64 lowercase hex hash> <hex data>.
Verify SHA-256 of the ASCII hex data against the header (hash the hex text, not decoded bytes).
Hex-decode the data, gzip-decompress it, then read the resulting USTAR archive in memory.
Recover the exact content bytes of payload.bin. Do not return the archive bytes or extract paths onto the filesystem.`,
  pngspeak: `PngSpeak stores bytes as RGBA pixels, row-major, four bytes per pixel (R,G,B,A).
This challenge uses an 8-bit RGBA PNG, non-interlaced, without resizing or art mode.
The PNG iTXt keyword "license" has uncompressed text with two space-separated hex integers:
the first is the byte length of the second field's ASCII representation; the second is the original payload byte length.
Read PNG pixels as RGBA without compositing transparency, concatenate their bytes, and truncate to that original length.
Alternatively concatenate IDAT chunks, zlib-decompress them, and remove each scanline's first filter byte (all are filter 0 in these files).
Keep alpha bytes, zero bytes, and trailing whitespace exactly.`,
  gptgif: `Original gptgif stores a byte payload visually.
The decoder must infer the glyph alphabet from the rendered image.
No font data is provided.
Do not assume glyph ordering.`,
  "gptgif-v4": `gptgif v4 is a 640x480 GIF with an initial calibration frame followed by payload frames.
Use the original GIF bytes. Read every frame as RGB without resizing. All cells are 8x8 pixels.
Calibration addressing is row-major: cell c begins at (8*(c%80), 8*floor(c/80)).
Cells 0..255 are solid color swatches identifying palette roles. Foreground roles are 40..239;
role 0 is background, 1..15 noise, and 31 decoys. Classify by RGB learned from swatches, not brightness.
Cells 320..335 show canonical glyphs for nibbles 0..15 using role 40 on background.
Cells 400..495 encode a 48-byte header with canonical glyphs: low nibble first, then high nibble.
Header bytes 0..7 are ASCII GPTGIF4 followed by NUL; 8..15 are uint64 little-endian payload length;
16..47 are the SHA-256 digest of the recovered payload.

Each payload frame carries at most 2400 bytes (4800 nibbles). Its frame index f starts at 0 after calibration.
All PRNG math is unsigned 32-bit. xorshift32(x): x ^= x<<13; x ^= x>>>17; x ^= x<<5;
mask to 32 bits after every step; >>> means unsigned right shift.
initial = (0xc0ffee00 + f*0x9e3779b1 + 0xdefc0ffe) modulo 2^32.
Start permutation P=[0..4799], state=initial. For k from 4799 down to 1:
state=xorshift32(state); swap P[k] with P[state%(k+1)].
Independently start glyphState=initial XOR 0x12345678. For logical slot i from 0..4799,
advance glyphState=xorshift32(glyphState); that is this slot's seed s.
Logical slot i: col=floor(i/60), row=i%60; reverse row to 59-row for odd col;
p=P[col*60+row]. Physical payload coordinates are column-major: (8*floor(p/60),8*(p%60)).

For each candidate canonical glyph, first remove pixels where (x+y)%2==1 if ((s>>>6)&7)==0.
Rotate its remaining coordinates by r=s&3:
r=0: (x,y); r=1: (7-y,x); r=2: (7-x,7-y); r=3: (y,7-x).
Then add jitter jx=min(((s>>>2)&3)-1,1), jy=min(((s>>>4)&3)-1,1).
Match the transformed mask to observed pixels in foreground roles 40..239, ignoring noise and decoys.
This yields encoded nibble e. Undo the shift: n=(e-((f*7+13)&15))&15.
On odd f, swap each consecutive pair of recovered nibbles.
Reassemble bytes low nibble first: byte=(n[2*j] | (n[2*j+1]<<4)) XOR 0xa5.
Read only the number of slots dictated by header length; concatenate frames and verify SHA-256.
The calibration alphabet and palette may vary; learn them from frame zero.`,
} as const;


// Human-readable Simplified Chinese guides used in generated prompts and downloaded kits.
// The English reference guides remain available for format comparison and future tooling.
export const decoderGuidesZh = {
  "loaf": "LoaF 是一行 ASCII 文本，格式为：SHA256(-)=<64 位小写十六进制哈希> <十六进制数据>。\n请对 ASCII 十六进制数据文本计算 SHA-256，并与头部中的哈希比较（哈希对象是十六进制文本，而不是解码后的字节）。\n将数据进行十六进制解码，再使用 gzip 解压，然后在内存中读取生成的 USTAR 归档。\n恢复 payload.bin 的精确内容字节。不要返回归档字节，也不要将归档路径提取到文件系统。",
  "pngspeak": "PngSpeak 将字节存储为 RGBA 像素，按行优先排列，每个像素四个字节（R、G、B、A）。\n本挑战使用 8 位 RGBA PNG，非隔行扫描，不进行缩放，也不使用艺术模式。\nPNG 的 iTXt 关键字 \"license\" 包含未压缩文本，其中有两个以空格分隔的十六进制整数：\n第一个整数表示第二个字段的 ASCII 文本长度；第二个整数表示原始载荷的字节长度。\n读取 PNG 像素时使用 RGBA，不要合成透明度；将像素字节串接起来，再截断到原始载荷长度。\n也可以串接 IDAT 块并进行 zlib 解压，然后移除每条扫描线的第一个滤波器字节（这些文件中的滤波器值均为 0）。\n必须原样保留 alpha 字节、零字节和末尾空白。",
  "gptgif": "原版 gptgif 以图像形式存储字节载荷。\n解码器必须根据渲染后的图像推断字形字母表。\n未提供字体数据。\n不要假设字形的排列顺序。",
  "gptgif-v4": "gptgif v4 是一张 640x480 的 GIF，包含一个初始校准帧，后面跟随载荷帧。\n使用原始 GIF 字节。将每一帧作为 RGB 读取，不要缩放。所有单元格均为 8x8 像素。\n校准帧的寻址方式为行优先：单元格 c 从坐标 (8*(c%80), 8*floor(c/80)) 开始。\n单元格 0..255 是纯色样本，用于标识调色板角色。前景角色为 40..239；角色 0 是背景，1..15 是噪声，31 是诱饵。应根据样本学习到的 RGB 值进行分类，而不是根据亮度分类。\n单元格 320..335 在背景上使用角色 40 显示半字节 0..15 的标准字形。\n单元格 400..495 使用标准字形编码一个 48 字节头部：先低半字节，再高半字节。\n头部字节 0..7 是 ASCII 字符串 GPTGIF4，后跟 NUL；8..15 是 uint64 小端序载荷长度；16..47 是恢复后载荷的 SHA-256 摘要。\n每个载荷帧最多携带 2400 字节（4800 个半字节）。校准帧之后的帧索引 f 从 0 开始。\n所有 PRNG 运算均使用无符号 32 位整数。xorshift32(x)：x ^= x<<13; x ^= x>>>17; x ^= x<<5；每一步后都将结果限制为 32 位；>>> 表示无符号右移。\ninitial = (0xc0ffee00 + f*0x9e3779b1 + 0xdefc0ffe) modulo 2^32。\n初始化排列 P=[0..4799]，state=initial。对于 k 从 4799 递减到 1：\nstate=xorshift32(state)；交换 P[k] 与 P[state%(k+1)]。\n独立初始化 glyphState=initial XOR 0x12345678。对于逻辑槽位 i（0..4799），执行 glyphState=xorshift32(glyphState)；该值就是此槽位的种子 s。\n逻辑槽位 i：col=floor(i/60)，row=i%60；若 col 为奇数，则将 row 反转为 59-row；p=P[col*60+row]。载荷的物理坐标按列优先排列：(8*floor(p/60),8*(p%60))。\n对于每个候选标准字形，如果 ((s>>>6)&7)==0，则先移除所有满足 (x+y)%2==1 的像素。\n将剩余坐标按 r=s&3 旋转：\nr=0: (x,y)；r=1: (7-y,x)；r=2: (7-x,7-y)；r=3: (y,7-x)。\n然后添加抖动：jx=min(((s>>>2)&3)-1,1)，jy=min(((s>>>4)&3)-1,1)。\n将变换后的掩码与前景角色 40..239 中的观测像素匹配，同时忽略噪声和诱饵。由此得到编码半字节 e。撤销偏移：n=(e-((f*7+13)&15))&15。\n当 f 为奇数时，交换恢复出的每一对相邻半字节。\n按低半字节优先重新组合字节：byte=(n[2*j] | (n[2*j+1]<<4)) XOR 0xa5。\n只读取由头部长度指定数量的槽位；串接各帧，并验证 SHA-256。\n校准字母表和调色板可能变化；请从第 0 帧学习。"
} as const;
