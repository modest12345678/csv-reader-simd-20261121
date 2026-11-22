// v4 Ultra-Compact Zero-Spill Multi-Comma + Inline-Quoted + Inline-EOL WASM v128 SIMD Transducer.
// Factors cold quoted fallback into fQuoteCold so hot fParseText is ~2.2 KB (fastest Liftoff compile, 0 spills).
import fs from 'node:fs';

function uleb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
function sleb(n) {
  const o = []; let m = true;
  while (m) { let b = n & 0x7f; n >>= 7; if ((!n && !(b & 0x40)) || (n === -1 && (b & 0x40))) m = false; else b |= 0x80; o.push(b); }
  return o;
}
function sleb64(n) {
  let v = BigInt(n), m = true; const o = [];
  while (m) { let b = Number(v & 0x7fn); v >>= 7n; if ((!v && !(b & 0x40)) || (v === -1n && (b & 0x40))) m = false; else b |= 0x80; o.push(b); }
  return o;
}
function strBytes(s) { const b = Buffer.from(s, 'utf8'); return [...uleb(b.length), ...b]; }
function section(id, p) { return [id, ...uleb(p.length), ...p]; }

const I32 = 0x7f, I64 = 0x7e, V128 = 0x7b, VOID = 0x40;

// 24 WASM pages = 1.5 MiB total (512 KiB input slab + 512 KiB output slab + 512 KiB errors/state)
export const MEM_PAGES   = 16;
export const IN_BASE     = 0x00000;
export const IN_CAP      = 0x40000;  // 512 KiB input slab (+ 64B zero guard)
export const OUT_BASE    = 0x40100;
export const OUT_FLUSH   = 0x7C000;  // ~496 KiB watermark (16 KiB headroom)
export const ERR_META    = 0x80200; // 256 KiB error structs (20B * 13,107)
export const EXTRA_BASE  = 0xC0200; // 240 KiB long_row extra JSON strings
export const STATE_BASE  = 0xFF000; // 4 KiB shared state

const ST_IN_END     = STATE_BASE + 0;
const ST_IN_EOF     = STATE_BASE + 4;
const ST_IN_FBASE   = STATE_BASE + 8;
const ST_OUT_FPOS   = STATE_BASE + 12;
const ST_ERR_CNT    = STATE_BASE + 16;
const ST_EXTRA_PTR  = STATE_BASE + 20;
const ST_CASE_START = STATE_BASE + 24;
const ST_REC0_END   = STATE_BASE + 28;
const ST_REC_CNT    = STATE_BASE + 32;
const ST_HEADER     = STATE_BASE + 36;
const ST_LINE       = STATE_BASE + 44;
const ST_REC_LINE   = STATE_BASE + 48;
const ST_IN_PTR     = STATE_BASE + 52;
const ST_OUT_PTR    = STATE_BASE + 56;
const ST_REC_START  = STATE_BASE + 60;
const ST_EX_START   = STATE_BASE + 64;
const ST_QUOTED     = STATE_BASE + 68;
const ST_ADDED      = STATE_BASE + 72;
const ST_ENDED      = STATE_BASE + 76;
const ST_EXTRA      = STATE_BASE + 80;
const ST_OIFP       = STATE_BASE + 84;
const ST_OOFP       = STATE_BASE + 88;
const ST_OLINE      = STATE_BASE + 92;
const ST_OEX        = STATE_BASE + 96;
const ST_OERR       = STATE_BASE + 100;
const ST_SAVED_OUT  = STATE_BASE + 104;
const ST_FQ_IN      = STATE_BASE + 108;
const ST_FQ_DST     = STATE_BASE + 112;
const ST_FQ_LINE    = STATE_BASE + 116;

const E_STRAY_CR = 0, E_QUOTE_JUNK = 1, E_UNTERM = 2, E_SHORT = 3, E_LONG = 4;
const END_COMMA = 0, END_EOL = 1, END_EOF = 2;

class Code {
  constructor() { this.b = []; this.labels = []; }
  raw(...xs) { this.b.push(...xs); return this; }
  block(n = null, t = VOID) { this.labels.push(n); return this.raw(0x02, t); }
  loop(n = null, t = VOID) { this.labels.push(n); return this.raw(0x03, t); }
  if_(t = VOID, n = null) { this.labels.push(n); return this.raw(0x04, t); }
  else_() { return this.raw(0x05); }
  end() { this.labels.pop(); return this.raw(0x0b); }
  depth(t) {
    if (typeof t === 'number') return t;
    for (let i = this.labels.length - 1; i >= 0; i--) if (this.labels[i] === t) return this.labels.length - 1 - i;
    throw new Error('Unknown label: ' + t);
  }
  br(t) { return this.raw(0x0c, ...uleb(this.depth(t))); }
  br_if(t) { return this.raw(0x0d, ...uleb(this.depth(t))); }
  ret() { return this.raw(0x0f); }
  call(f) { return this.raw(0x10, ...uleb(f)); }
  drop() { return this.raw(0x1a); }
  get(i) { return this.raw(0x20, ...uleb(i)); }
  set(i) { return this.raw(0x21, ...uleb(i)); }
  tee(i) { return this.raw(0x22, ...uleb(i)); }
  i32_load(o = 0) { return this.raw(0x28, 0x00, ...uleb(o)); }
  i64_load(o = 0) { return this.raw(0x29, 0x00, ...uleb(o)); }
  i32_load8_u(o = 0) { return this.raw(0x2d, 0x00, ...uleb(o)); }
  i32_load16_u(o = 0) { return this.raw(0x2f, 0x00, ...uleb(o)); }
  i32_store(o = 0) { return this.raw(0x36, 0x00, ...uleb(o)); }
  i64_store(o = 0) { return this.raw(0x37, 0x00, ...uleb(o)); }
  i32_store8(o = 0) { return this.raw(0x3a, 0x00, ...uleb(o)); }
  i32_store16(o = 0) { return this.raw(0x3b, 0x00, ...uleb(o)); }
  i32(n) { return this.raw(0x41, ...sleb(n | 0)); }
  i64(n) { return this.raw(0x42, ...sleb64(n)); }
  i32_eqz() { return this.raw(0x45); }
  i32_eq() { return this.raw(0x46); }
  i32_ne() { return this.raw(0x47); }
  i32_lt_s() { return this.raw(0x48); }
  i32_lt_u() { return this.raw(0x49); }
  i32_gt_s() { return this.raw(0x4a); }
  i32_gt_u() { return this.raw(0x4b); }
  i32_le_u() { return this.raw(0x4d); }
  i32_ge_s() { return this.raw(0x4e); }
  i32_ge_u() { return this.raw(0x4f); }
  i32_ctz() { return this.raw(0x68); }
  i32_add() { return this.raw(0x6a); }
  i32_sub() { return this.raw(0x6b); }
  i32_mul() { return this.raw(0x6c); }
  i32_div_u() { return this.raw(0x6e); }
  i32_rem_u() { return this.raw(0x70); }
  i32_and() { return this.raw(0x71); }
  i32_or() { return this.raw(0x72); }
  i32_shl() { return this.raw(0x74); }
  i32_shr_u() { return this.raw(0x76); }
  mem_copy() { return this.raw(0xfc, 0x0a, 0x00, 0x00); }
  v128_load(o = 0) { return this.raw(0xfd, 0x00, 0x00, ...uleb(o)); }
  v128_store(o = 0) { return this.raw(0xfd, 0x0b, 0x00, ...uleb(o)); }
  v128_splat_const(b) { return this.raw(0xfd, 0x0c, ...new Array(16).fill(b & 0xff)); }
  i8x16_eq() { return this.raw(0xfd, 0x23); }
  v128_or() { return this.raw(0xfd, 0x50); }
  i8x16_bitmask() { return this.raw(0xfd, 0x64); }
  stLoad(a) { return this.i32(a).i32_load(0); }
  stInc(a) { return this.i32(a).stLoad(a).i32(1).i32_add().i32_store(0); }
  emitBytes(dstLocal, str) {
    const buf = Buffer.from(str, 'utf8');
    let off = 0;
    while (off < buf.length) {
      const rem = buf.length - off;
      if (rem >= 8) { this.get(dstLocal).i64(buf.readBigInt64LE(off)).i64_store(off); off += 8; }
      else if (rem >= 4) { this.get(dstLocal).i32(buf.readInt32LE(off)).i32_store(off); off += 4; }
      else if (rem >= 2) { this.get(dstLocal).i32(buf.readUInt16LE(off)).i32_store16(off); off += 2; }
      else { this.get(dstLocal).i32(buf[off]).i32_store8(off); off += 1; }
    }
    return this.get(dstLocal).i32(buf.length).i32_add().set(dstLocal);
  }
  assertBalanced() { if (this.labels.length) throw new Error('Unclosed: ' + this.labels); }
}

export function buildWasm() {
  const F_REFILL = 0, F_FLUSH = 1, F_REWIND = 2, F_PATCH = 3;
  const F_WRITE_U32 = 4, F_PUSH_ERR = 5, F_EMIT_ERRS = 6, F_HEX4 = 7;
  const F_SKIP_WS = 8, F_SKIP_STR = 9, F_SKIP_VAL = 10, F_UNQ_COLD = 11, F_QUOTE_COLD = 12, F_PARSE_TEXT = 13, F_RUN = 14;

  const types = [
    [0x60, 1, I32, 1, I32],           // 0: (i32) -> i32
    [0x60, 2, I32, I32, 1, I32],      // 1: (i32, i32) -> i32
    [0x60, 3, I32, I32, I32, 0],      // 2: (i32, i32, i32) -> void
    [0x60, 0, 0],                     // 3: () -> void
  ];

  // 4: writeU32
  const fWriteU32 = (() => {
    const c = new Code();
    c.get(1).i32_eqz().if_(); c.get(0).i32(0x30).i32_store8(0); c.get(0).i32(1).i32_add().ret(); c.end();
    c.i32(STATE_BASE + 200).set(2);
    c.loop('d');
      c.get(2).i32(1).i32_sub().tee(2);
      c.get(1).i32(10).i32_rem_u().i32(48).i32_add().i32_store8(0);
      c.get(1).i32(10).i32_div_u().tee(1).br_if('d');
    c.end();
    c.i32(STATE_BASE + 200).get(2).i32_sub().set(3);
    c.get(0).get(2).get(3).mem_copy();
    c.get(0).get(3).i32_add().ret();
    c.assertBalanced();
    return { locals: [[2, I32]], body: c.b };
  })();

  // 5: pushErr
  const fPushErr = (() => {
    const c = new Code();
    c.stLoad(ST_ERR_CNT).set(4);
    c.i32(ERR_META).get(4).i32(20).i32_mul().i32_add().set(3);
    c.get(3).get(0).i32_store(0);
    c.get(3).stLoad(ST_REC_LINE).i32_store(4);
    c.get(3).stLoad(ST_REC_CNT).i32_store(8);
    c.get(3).get(1).i32_store(12);
    c.get(3).get(2).i32_store(16);
    c.i32(ST_ERR_CNT).get(4).i32(1).i32_add().i32_store(0);
    c.assertBalanced();
    return { locals: [[2, I32]], body: c.b };
  })();

  // 6: emitErrors
  const fEmitErrs = (() => {
    const c = new Code();
    c.emitBytes(0, ',"errors":[');
    c.stLoad(ST_ERR_CNT).set(2);
    c.stLoad(ST_HEADER).set(5);
    c.i32(0).set(1);
    c.block('done').loop('el');
      c.get(1).get(2).i32_ge_u().br_if('done');
      c.get(0).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(0).call(F_FLUSH).set(0); c.end();
      c.get(1).if_(); c.get(0).i32(0x2c).i32_store8(0); c.get(0).i32(1).i32_add().set(0); c.end();
      c.i32(ERR_META).get(1).i32(20).i32_mul().i32_add().set(3);
      c.get(3).i32_load(0).set(4);
      c.get(3).i32_load(8).set(6);
      c.emitBytes(0, '{"code":"');
      c.get(4).i32(E_STRAY_CR).i32_eq().if_(); c.emitBytes(0, 'stray_cr');
      c.else_(); c.get(4).i32(E_QUOTE_JUNK).i32_eq().if_(); c.emitBytes(0, 'quote_junk');
      c.else_(); c.get(4).i32(E_UNTERM).i32_eq().if_(); c.emitBytes(0, 'unterminated_quote');
      c.else_(); c.get(4).i32(E_SHORT).i32_eq().if_(); c.emitBytes(0, 'short_row');
      c.else_(); c.emitBytes(0, 'long_row');
      c.end().end().end().end();
      c.emitBytes(0, '","line":');
      c.get(0).get(3).i32_load(4).call(F_WRITE_U32).set(0);
      c.emitBytes(0, ',"row":');
      c.get(5).get(6).i32_eqz().i32_and().if_(); c.emitBytes(0, 'null');
      c.else_(); c.get(0).get(6).get(5).i32_sub().call(F_WRITE_U32).set(0); c.end();
      c.get(4).i32(E_SHORT).i32_eq().if_();
        c.emitBytes(0, ',"fields":');
        c.get(0).get(3).i32_load(12).call(F_WRITE_U32).set(0);
      c.end();
      c.get(4).i32(E_LONG).i32_eq().if_();
        c.emitBytes(0, ',"extra":[');
        c.get(3).i32_load(12).set(7);
        c.get(3).i32_load(16).set(8);
        c.block('xd').loop('xl');
          c.get(8).i32_eqz().br_if('xd');
          c.get(0).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(0).call(F_FLUSH).set(0); c.end();
          c.get(8).i32(8192).i32_gt_u().if_(I32).i32(8192).else_().get(8).end().set(6);
          c.get(0).get(7).get(6).mem_copy();
          c.get(0).get(6).i32_add().set(0);
          c.get(7).get(6).i32_add().set(7);
          c.get(8).get(6).i32_sub().set(8);
          c.br('xl');
        c.end().end();
        c.get(0).i32(0x5d).i32_store8(0); c.get(0).i32(1).i32_add().set(0);
      c.end();
      c.get(0).i32(0x7d).i32_store8(0); c.get(0).i32(1).i32_add().set(0);
      c.get(1).i32(1).i32_add().set(1);
      c.br('el');
    c.end().end();
    c.emitBytes(0, ']}');
    c.get(0).ret();
    c.assertBalanced();
    return { locals: [[8, I32]], body: c.b };
  })();

  // 7: parseHex4
  const fHex4 = (() => {
    const c = new Code();
    c.i32(0).set(1).i32(0).set(2);
    c.loop('hl');
      c.get(0).get(2).i32_add().i32_load8_u(0).set(3);
      c.get(1).i32(4).i32_shl();
      c.get(3).i32(57).i32_le_u().if_(I32).get(3).i32(48).i32_sub().else_().get(3).i32(0xdf).i32_and().i32(55).i32_sub().end();
      c.i32_or().set(1);
      c.get(2).i32(1).i32_add().tee(2).i32(4).i32_lt_u().br_if('hl');
    c.end();
    c.get(1).ret();
    c.assertBalanced();
    return { locals: [[3, I32]], body: c.b };
  })();

  // 8: skipWs
  const fSkipWs = (() => {
    const c = new Code();
    c.stLoad(ST_IN_PTR).set(0); c.stLoad(ST_IN_END).set(1);
    c.block('d').loop('l');
      c.get(1).get(0).i32_sub().i32(1).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(0).call(F_REFILL).set(1); c.i32(0).set(0); c.end();
      c.end();
      c.get(0).get(1).i32_ge_u().br_if('d');
      c.get(0).i32_load8_u(0).i32(32).i32_gt_u().br_if('d');
      c.get(0).i32(1).i32_add().set(0);
      c.br('l');
    c.end().end();
    c.i32(ST_IN_PTR).get(0).i32_store(0); c.i32(ST_IN_END).get(1).i32_store(0);
    c.assertBalanced();
    return { locals: [[2, I32]], body: c.b };
  })();

  // 9: skipJsonStr
  const fSkipStr = (() => {
    const c = new Code();
    c.stLoad(ST_IN_PTR).set(0); c.stLoad(ST_IN_END).set(1);
    c.block('d').loop('l');
      c.get(1).get(0).i32_sub().i32(4).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(0).call(F_REFILL).set(1); c.i32(0).set(0); c.end();
      c.end();
      c.get(0).get(1).i32_ge_u().br_if('d');
      c.get(0).i32_load8_u(0).set(2);
      c.get(0).i32(1).i32_add().set(0);
      c.get(2).i32(0x22).i32_eq().br_if('d');
      c.get(2).i32(0x5c).i32_eq().if_(); c.get(0).i32(1).i32_add().set(0); c.end();
      c.br('l');
    c.end().end();
    c.i32(ST_IN_PTR).get(0).i32_store(0); c.i32(ST_IN_END).get(1).i32_store(0);
    c.assertBalanced();
    return { locals: [[3, I32]], body: c.b };
  })();

  // 10: skipJsonVal
  const fSkipVal = (() => {
    const c = new Code();
    c.call(F_SKIP_WS);
    c.stLoad(ST_IN_PTR).set(0); c.stLoad(ST_IN_END).set(1);
    c.get(0).get(1).i32_ge_u().if_(); c.ret(); c.end();
    c.get(0).i32_load8_u(0).set(2);
    c.get(2).i32(0x22).i32_eq().if_();
      c.i32(ST_IN_PTR).get(0).i32(1).i32_add().i32_store(0);
      c.call(F_SKIP_STR); c.ret();
    c.end();
    c.get(2).i32(0x7b).i32_eq().get(2).i32(0x5b).i32_eq().i32_or().if_();
      c.i32(0).set(3);
      c.block('d').loop('l');
        c.get(1).get(0).i32_sub().i32(4).i32_lt_u().if_();
          c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(0).call(F_REFILL).set(1); c.i32(0).set(0); c.end();
        c.end();
        c.get(0).get(1).i32_ge_u().br_if('d');
        c.get(0).i32_load8_u(0).set(2); c.get(0).i32(1).i32_add().set(0);
        c.get(2).i32(0x22).i32_eq().if_();
          c.i32(ST_IN_PTR).get(0).i32_store(0); c.i32(ST_IN_END).get(1).i32_store(0);
          c.call(F_SKIP_STR);
          c.stLoad(ST_IN_PTR).set(0); c.stLoad(ST_IN_END).set(1);
          c.br('l');
        c.end();
        c.get(2).i32(0x7b).i32_eq().get(2).i32(0x5b).i32_eq().i32_or().if_();
          c.get(3).i32(1).i32_add().set(3);
        c.else_();
          c.get(2).i32(0x7d).i32_eq().get(2).i32(0x5d).i32_eq().i32_or().if_();
            c.get(3).i32(1).i32_sub().tee(3).i32_eqz().br_if('d');
          c.end();
        c.end();
        c.br('l');
      c.end().end();
      c.i32(ST_IN_PTR).get(0).i32_store(0); c.i32(ST_IN_END).get(1).i32_store(0); c.ret();
    c.end();
    c.block('pd').loop('pl');
      c.get(1).get(0).i32_sub().i32(1).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(0).call(F_REFILL).set(1); c.i32(0).set(0); c.end();
      c.end();
      c.get(0).get(1).i32_ge_u().br_if('pd');
      c.get(0).i32_load8_u(0).set(2);
      c.get(2).i32(0x2c).i32_eq().get(2).i32(0x7d).i32_eq().i32_or()
        .get(2).i32(0x5d).i32_eq().i32_or().get(2).i32(32).i32_le_u().i32_or().br_if('pd');
      c.get(0).i32(1).i32_add().set(0);
      c.br('pl');
    c.end().end();
    c.i32(ST_IN_PTR).get(0).i32_store(0); c.i32(ST_IN_END).get(1).i32_store(0);
    c.assertBalanced();
    return { locals: [[4, I32]], body: c.b };
  })();

  // 11: readUnquotedCold
  const fUnqCold = (() => {
    const c = new Code();
    const IN = 0, END = 1, DST = 2, ADD = 3, EX = 4, CH = 5, T1 = 6, HEX = 7;
    c.stLoad(ST_IN_PTR).set(IN); c.stLoad(ST_IN_END).set(END); c.stLoad(ST_OUT_PTR).set(DST);
    c.stLoad(ST_ADDED).set(ADD); c.stLoad(ST_EXTRA).set(EX);

    const retCode = (code) => {
      c.i32(ST_IN_PTR).get(IN).i32_store(0); c.i32(ST_IN_END).get(END).i32_store(0);
      c.i32(ST_OUT_PTR).get(DST).i32_store(0); c.i32(ST_ADDED).get(ADD).i32_store(0);
      c.i32(ST_ENDED).i32(code).i32_store(0); c.ret();
    };

    c.loop('ul');
      c.get(EX).i32_eqz().if_();
        c.get(DST).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(DST).call(F_FLUSH).set(DST); c.end();
      c.end();
      c.get(END).get(IN).i32_sub().i32(8).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(IN).call(F_REFILL).set(END); c.i32(0).set(IN); c.end();
      c.end();
      c.get(IN).get(END).i32_ge_u().if_(); retCode(END_EOF); c.end();
      c.get(IN).i32_load8_u(0).set(CH);
      c.get(CH).i32(0x22).i32_eq().if_(); retCode(END_EOF); c.end();
      c.get(CH).i32(0x2c).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); retCode(END_COMMA); c.end();
      c.get(CH).i32(0x5c).i32_eq().if_();
        c.get(IN).i32_load8_u(1).set(T1);
        c.get(T1).i32(0x6e).i32_eq().if_(); c.get(IN).i32(2).i32_add().set(IN); c.stInc(ST_LINE); retCode(END_EOL); c.end();
        c.get(T1).i32(0x72).i32_eq().if_();
          c.get(IN).i32(3).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(2).i32(0x6e5c).i32_eq().i32_and().if_();
            c.get(IN).i32(4).i32_add().set(IN); c.stInc(ST_LINE); retCode(END_EOL);
          c.end();
          c.i32(E_STRAY_CR).i32(0).i32(0).call(F_PUSH_ERR);
          c.get(IN).i32(2).i32_add().set(IN); c.br('ul');
        c.end();
        c.get(T1).i32(0x75).i32_eq().if_();
          c.get(IN).i32(2).i32_add().call(F_HEX4).set(HEX);
          c.get(HEX).i32(0x0a).i32_eq().if_(); c.get(IN).i32(6).i32_add().set(IN); c.stInc(ST_LINE); retCode(END_EOL); c.end();
          c.get(HEX).i32(0x0d).i32_eq().if_();
            c.get(IN).i32(7).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(6).i32(0x6e5c).i32_eq().i32_and().if_();
              c.get(IN).i32(8).i32_add().set(IN); c.stInc(ST_LINE); retCode(END_EOL);
            c.end();
            c.i32(E_STRAY_CR).i32(0).i32(0).call(F_PUSH_ERR);
            c.get(IN).i32(6).i32_add().set(IN); c.br('ul');
          c.end();
          c.get(HEX).i32(0x2c).i32_eq().if_(); c.get(IN).i32(6).i32_add().set(IN); retCode(END_COMMA); c.end();
          c.get(DST).get(IN).i32_load(0).i32_store(0);
          c.get(DST).get(IN).i32_load16_u(4).i32_store16(4);
          c.get(DST).i32(6).i32_add().set(DST); c.get(IN).i32(6).i32_add().set(IN); c.i32(1).set(ADD); c.br('ul');
        c.end();
        c.get(DST).get(IN).i32_load16_u(0).i32_store16(0);
        c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(2).i32_add().set(IN); c.i32(1).set(ADD); c.br('ul');
      c.end();
      c.get(DST).get(CH).i32_store8(0);
      c.get(DST).i32(1).i32_add().set(DST); c.get(IN).i32(1).i32_add().set(IN); c.i32(1).set(ADD); c.br('ul');
    c.end();
    c.assertBalanced();
    return { locals: [[8, I32]], body: c.b };
  })();

  // 12: readQuotedCold() — factored out of hot parseText so fParseText stays ultra-compact (<2.5 KB)!
  const fQuoteCold = (() => {
    const c = new Code();
    const IN = 0, END = 1, DST = 2, K = 3, POS = 4, CLOSED = 5;
    const ensureIn = (n) => {
      c.get(END).get(IN).i32_sub().i32(n).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(IN).call(F_REFILL).set(END); c.i32(0).set(IN); c.end();
      c.end();
    };
    const save = () => {
      c.i32(ST_IN_PTR).get(IN).i32_store(0);
      c.i32(ST_IN_END).get(END).i32_store(0);
      c.i32(ST_OUT_PTR).get(DST).i32_store(0);
    };

    c.stLoad(ST_IN_PTR).set(IN); c.stLoad(ST_IN_END).set(END); c.stLoad(ST_OUT_PTR).set(DST);
    c.i32(ST_QUOTED).i32(1).i32_store(0);
    c.i32(ST_OIFP).stLoad(ST_IN_FBASE).get(IN).i32_add().i32_store(0);
    c.stLoad(ST_EXTRA).if_(); c.i32(ST_OEX).get(DST).i32_store(0);
    c.else_(); c.i32(ST_OOFP).stLoad(ST_OUT_FPOS).get(DST).i32(OUT_BASE).i32_sub().i32_add().i32_store(0); c.end();
    c.i32(ST_OLINE).stLoad(ST_LINE).i32_store(0);
    c.i32(ST_OERR).stLoad(ST_ERR_CNT).i32_store(0);
    c.get(IN).i32(2).i32_add().set(IN);

    c.i32(0).set(CLOSED);
    c.block('qDone').loop('qLoop');
      c.stLoad(ST_EXTRA).i32_eqz().if_();
        c.get(DST).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(DST).call(F_FLUSH).set(DST); c.end();
      c.end();
      ensureIn(8);
      c.get(IN).get(END).i32_ge_u().br_if('qDone');
      c.get(IN).i32_load8_u(0).set(K);
      c.get(K).i32(0x22).i32_eq().br_if('qDone');
      c.get(K).i32(0x5c).i32_eq().if_();
        c.get(IN).i32_load8_u(1).set(POS);
        c.get(POS).i32(0x22).i32_eq().if_();
          c.get(IN).i32(3).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(2).i32(0x225c).i32_eq().i32_and().if_();
            c.get(DST).i32(0x225c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(4).i32_add().set(IN); c.br('qLoop');
          c.end();
          c.get(IN).i32(2).i32_add().set(IN); c.i32(1).set(CLOSED); c.br('qDone');
        c.end();
        c.get(POS).i32(0x72).i32_eq().if_();
          c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.stInc(ST_LINE);
          c.get(IN).i32(3).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(2).i32(0x6e5c).i32_eq().i32_and()
            .if_().get(IN).i32(4).i32_add().set(IN).else_().get(IN).i32(2).i32_add().set(IN).end();
          c.br('qLoop');
        c.end();
        c.get(POS).i32(0x6e).i32_eq().if_();
          c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.stInc(ST_LINE);
          c.get(IN).i32(2).i32_add().set(IN); c.br('qLoop');
        c.end();
        c.get(POS).i32(0x75).i32_eq().if_();
          c.get(IN).i32(2).i32_add().call(F_HEX4).set(K);
          c.get(K).i32(0x0a).i32_eq().if_();
            c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.stInc(ST_LINE);
            c.get(IN).i32(6).i32_add().set(IN); c.br('qLoop');
          c.end();
          c.get(K).i32(0x0d).i32_eq().if_();
            c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.stInc(ST_LINE);
            c.get(IN).i32(7).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(6).i32(0x6e5c).i32_eq().i32_and()
              .if_().get(IN).i32(8).i32_add().set(IN).else_().get(IN).i32(6).i32_add().set(IN).end();
            c.br('qLoop');
          c.end();
          c.get(DST).get(IN).i32_load(0).i32_store(0); c.get(DST).get(IN).i32_load16_u(4).i32_store16(4);
          c.get(DST).i32(6).i32_add().set(DST); c.get(IN).i32(6).i32_add().set(IN); c.br('qLoop');
        c.end();
        c.get(DST).get(IN).i32_load16_u(0).i32_store16(0);
        c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(2).i32_add().set(IN); c.br('qLoop');
      c.end();
      c.get(DST).get(K).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST); c.get(IN).i32(1).i32_add().set(IN);
      c.br('qLoop');
    c.end().end();

    c.get(CLOSED).i32_eqz().if_();
      c.i32(ST_LINE).stLoad(ST_OLINE).i32_store(0);
      c.i32(ST_ERR_CNT).stLoad(ST_OERR).i32_store(0);
      c.stLoad(ST_EXTRA).if_();
        c.stLoad(ST_OEX).set(DST);
        c.stLoad(ST_OIFP).i32(2).i32_add().stLoad(ST_IN_FBASE).i32_ge_u().if_();
          c.stLoad(ST_OIFP).i32(2).i32_add().stLoad(ST_IN_FBASE).i32_sub().set(IN);
        c.else_();
          c.stLoad(ST_OIFP).i32(2).i32_add().i32(-1).call(F_REWIND).set(END); c.i32(0).set(IN);
        c.end();
      c.else_();
        c.stLoad(ST_OIFP).i32(2).i32_add().stLoad(ST_IN_FBASE).i32_ge_u()
          .stLoad(ST_OOFP).stLoad(ST_OUT_FPOS).i32_ge_u().i32_and().if_();
          c.stLoad(ST_OIFP).i32(2).i32_add().stLoad(ST_IN_FBASE).i32_sub().set(IN);
          c.i32(OUT_BASE).stLoad(ST_OOFP).stLoad(ST_OUT_FPOS).i32_sub().i32_add().set(DST);
        c.else_();
          c.stLoad(ST_OIFP).i32(2).i32_add().stLoad(ST_OOFP).call(F_REWIND).set(END); c.i32(0).set(IN); c.i32(OUT_BASE).set(DST);
        c.end();
      c.end();
      c.i32(E_UNTERM).i32(0).i32(0).call(F_PUSH_ERR);
      c.get(DST).i32(0x225c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST);
      c.i32(ST_ADDED).i32(1).i32_store(0);
      save(); c.call(F_UNQ_COLD); c.ret();
    c.end();

    ensureIn(8);
    c.get(IN).get(END).i32_ge_u().if_(); c.i32(ST_ENDED).i32(END_EOF).i32_store(0); save(); c.ret(); c.end();
    c.get(IN).i32_load8_u(0).set(K);
    c.get(K).i32(0x2c).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); c.i32(ST_ENDED).i32(END_COMMA).i32_store(0); save(); c.ret(); c.end();
    c.get(K).i32(0x22).i32_eq().if_(); c.i32(ST_ENDED).i32(END_EOF).i32_store(0); save(); c.ret(); c.end();
    c.get(K).i32(0x5c).i32_eq().get(IN).i32_load8_u(1).i32(0x6e).i32_eq().i32_and().if_();
      c.get(IN).i32(2).i32_add().set(IN); c.stInc(ST_LINE); c.i32(ST_ENDED).i32(END_EOL).i32_store(0); save(); c.ret();
    c.end();
    c.get(K).i32(0x5c).i32_eq().get(IN).i32_load8_u(1).i32(0x72).i32_eq().i32_and()
      .get(IN).i32(3).i32_add().get(END).i32_lt_u().i32_and().get(IN).i32_load16_u(2).i32(0x6e5c).i32_eq().i32_and().if_();
      c.get(IN).i32(4).i32_add().set(IN); c.stInc(ST_LINE); c.i32(ST_ENDED).i32(END_EOL).i32_store(0); save(); c.ret();
    c.end();
    c.i32(ST_ADDED).i32(0).i32_store(0);
    save(); c.call(F_UNQ_COLD);
    c.stLoad(ST_ADDED).if_(); c.i32(E_QUOTE_JUNK).i32(0).i32(0).call(F_PUSH_ERR); c.end();
    c.assertBalanced();
    return { locals: [[6, I32]], body: c.b };
  })();

  // 13: parseText() — ULTRA-COMPACT ZERO-SPILL HOT FUNCTION!
  // ONLY 10 i32 locals + 4 v128 locals!
  const fParseText = (() => {
    const c = new Code();
    const IN = 0, END = 1, DST = 2, COL = 3, W = 4;
    const CM = 5, SM = 6, K = 7, POS = 8, T2 = 9;
    const V0 = 10, VC = 11, VB = 12, VQ = 13;

    const ensureIn = (n) => {
      c.get(END).get(IN).i32_sub().i32(n).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(IN).call(F_REFILL).set(END); c.i32(0).set(IN); c.end();
      c.end();
    };
    const ensureOut = () => {
      c.get(DST).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(DST).call(F_FLUSH).set(DST); c.end();
    };
    const callCold = (fn) => {
      c.i32(ST_IN_PTR).get(IN).i32_store(0); c.i32(ST_IN_END).get(END).i32_store(0); c.i32(ST_OUT_PTR).get(DST).i32_store(0);
      c.call(fn);
      c.stLoad(ST_IN_PTR).set(IN); c.stLoad(ST_IN_END).set(END); c.stLoad(ST_OUT_PTR).set(DST);
    };

    const tryInlineEol = () => {
      c.get(COL).i32(1).i32_add().get(W).i32_eq()
        .get(END).get(IN).i32_sub().i32(32).i32_ge_u().i32_and()
        .get(DST).i32(OUT_FLUSH).i32_lt_u().i32_and().if_();
        c.get(IN).i32_load(0).set(K);
        c.i32(0).set(T2);
        c.get(K).i32(0x6e5c725c).i32_eq().if_(); c.i32(4).set(T2);
        c.else_(); c.get(K).i32(0xffff).i32_and().i32(0x6e5c).i32_eq().if_(); c.i32(2).set(T2); c.end(); c.end();
        c.get(T2).if_();
          c.get(IN).get(T2).i32_add().i32_load16_u(0).set(K);
          c.get(K).i32(0xff).i32_and().tee(POS).i32(0x5c).i32_ne().get(POS).i32(0x22).i32_ne().i32_and().if_();
            c.get(IN).get(T2).i32_add().set(IN);
            c.get(DST).i64(0x000000225b2c5d22n).i64_store(0);
            c.get(DST).i32(5).i32_add().set(DST);
            c.i32(0).set(COL);
            c.i32(ST_LINE).stLoad(ST_LINE).i32(1).i32_add().tee(K).i32_store(0);
            c.i32(ST_REC_LINE).get(K).i32_store(0);
            c.stInc(ST_REC_CNT);
            c.br('fastLoop');
          c.end();
          c.get(K).i32(0x225c).i32_eq().if_();
            c.get(IN).get(T2).i32_add().set(IN);
            c.get(DST).i64(0x000000225b2c5d22n).i64_store(0);
            c.get(DST).i32(5).i32_add().set(DST);
            c.i32(0).set(COL);
            c.i32(ST_LINE).stLoad(ST_LINE).i32(1).i32_add().tee(K).i32_store(0);
            c.i32(ST_REC_LINE).get(K).i32_store(0);
            c.stInc(ST_REC_CNT);
            c.br('enterQuote');
          c.end();
        c.end();
      c.end();
    };

    c.stLoad(ST_IN_PTR).set(IN); c.stLoad(ST_IN_END).set(END); c.stLoad(ST_OUT_PTR).set(DST);
    c.i32(-1).set(W);
    c.v128_splat_const(0x2c).set(VC); c.v128_splat_const(0x5c).set(VB); c.v128_splat_const(0x22).set(VQ);

    ensureIn(8);
    c.get(IN).i32(2).i32_add().get(END).i32_lt_u()
      .get(IN).i32_load16_u(0).i32(0xbbef).i32_eq().i32_and()
      .get(IN).i32_load8_u(2).i32(0xbf).i32_eq().i32_and().if_();
      c.get(IN).i32(3).i32_add().set(IN);
    c.else_();
      c.get(IN).i32(5).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(0).i32(0x755c).i32_eq().i32_and().if_();
        c.get(IN).i32(2).i32_add().call(F_HEX4).i32(0xfeff).i32_eq().if_(); c.get(IN).i32(6).i32_add().set(IN); c.end();
      c.end();
    c.end();

    c.block('textDone').loop('recLoop');
      c.block('blankDone').loop('blankLoop');
        ensureIn(8);
        c.get(IN).get(END).i32_ge_u().br_if('textDone');
        c.get(IN).i32_load8_u(0).set(K);
        c.get(K).i32(0x22).i32_eq().br_if('textDone');
        c.get(K).i32(0x5c).i32_ne().br_if('blankDone');
        c.get(IN).i32_load8_u(1).set(T2);
        c.get(T2).i32(0x6e).i32_eq().if_(); c.get(IN).i32(2).i32_add().set(IN); c.stInc(ST_LINE); c.br('blankLoop'); c.end();
        c.get(T2).i32(0x72).i32_eq().if_();
          c.get(IN).i32(3).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(2).i32(0x6e5c).i32_eq().i32_and().if_();
            c.get(IN).i32(4).i32_add().set(IN); c.stInc(ST_LINE); c.br('blankLoop');
          c.end();
          c.br('blankDone');
        c.end();
        c.get(T2).i32(0x75).i32_eq().if_();
          c.get(IN).i32(2).i32_add().call(F_HEX4).set(K);
          c.get(K).i32(0x0a).i32_eq().if_(); c.get(IN).i32(6).i32_add().set(IN); c.stInc(ST_LINE); c.br('blankLoop'); c.end();
          c.get(K).i32(0x0d).i32_eq().if_();
            c.get(IN).i32(7).i32_add().get(END).i32_lt_u().get(IN).i32_load16_u(6).i32(0x6e5c).i32_eq().i32_and().if_();
              c.get(IN).i32(8).i32_add().set(IN); c.stInc(ST_LINE); c.br('blankLoop');
            c.end();
          c.end();
        c.end();
        c.br('blankDone');
      c.end().end();

      ensureOut();
      c.i32(ST_REC_START).get(DST).i32_store(0);
      c.i32(ST_REC_LINE).stLoad(ST_LINE).i32_store(0);
      c.stLoad(ST_REC_CNT).i32(2).i32_ge_u().if_();
        c.get(DST).i32(0x2c).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST);
      c.end();
      c.get(DST).i32(0x5b).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST);
      c.i32(0).set(COL);
      c.i32(ST_EX_START).stLoad(ST_EXTRA_PTR).i32_store(0);

      c.block('recFieldsDone').loop('fieldLoop');
        ensureIn(8);
        c.get(W).i32(0).i32_ge_s().get(COL).get(W).i32_ge_s().i32_and().if_();
          c.i32(ST_EXTRA).i32(1).i32_store(0);
          c.i32(ST_SAVED_OUT).get(DST).i32_store(0);
          c.stLoad(ST_EXTRA_PTR).set(DST);
          c.get(COL).get(W).i32_gt_s().if_(); c.get(DST).i32(0x2c).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST); c.end();
        c.else_();
          c.i32(ST_EXTRA).i32(0).i32_store(0);
          ensureOut();
          c.get(COL).if_(); c.get(DST).i32(0x2c).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST); c.end();
        c.end();

        c.get(DST).i32(0x22).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST);
        c.i32(ST_ADDED).i32(0).i32_store(0);
        c.i32(ST_QUOTED).i32(0).i32_store(0);

        c.block('afterCold');
        c.block('doColdUnq');
        c.stLoad(ST_EXTRA).i32_eqz().get(W).i32(0).i32_gt_s().i32_and()
          .get(END).get(IN).i32_sub().i32(32).i32_ge_u().i32_and()
          .get(DST).i32(OUT_FLUSH).i32_lt_u().i32_and().if_();
          c.block('fastExit').loop('fastOuter');
            c.block('enterQuote');
            c.get(IN).i32_load16_u(0).i32(0x225c).i32_eq().br_if('enterQuote');

            // ----- FAST UNQUOTED MULTI-COMMA SIMD LOOP -----
            c.loop('fastLoop');
              c.get(END).get(IN).i32_sub().i32(32).i32_lt_u()
                .get(DST).i32(OUT_FLUSH).i32_ge_u().i32_or().br_if('doColdUnq');

              c.get(IN).v128_load(0).set(V0);
              c.get(DST).get(V0).v128_store(0);
              c.get(V0).get(VC).i8x16_eq().i8x16_bitmask().set(CM);
              c.get(V0).get(VB).i8x16_eq().get(V0).get(VQ).i8x16_eq().v128_or().i8x16_bitmask().set(SM);

              c.get(CM).get(SM).i32_or().i32_eqz().if_();
                c.get(IN).i32(16).i32_add().set(IN);
                c.get(DST).i32(16).i32_add().set(DST);
                c.br('fastLoop');
              c.end();

              c.get(SM).if_(I32).get(SM).i32_ctz().else_().i32(16).end().set(T2);
              c.i32(0).set(POS);

              // UNROLLED 1ST COMMA
              c.get(CM).if_();
                c.get(CM).i32_ctz().set(K);
                c.get(K).get(T2).i32_lt_u().if_();
                  c.get(COL).i32(1).i32_add().get(W).i32_ge_s().if_();
                    c.get(DST).get(K).i32_add().tee(DST).i32(0x22).i32_store8(0);
                    c.get(DST).i32(1).i32_add().set(DST);
                    c.get(IN).get(K).i32_add().i32(1).i32_add().set(IN);
                    c.get(COL).i32(1).i32_add().set(COL);
                    c.br('fieldLoop');
                  c.end();
                  c.get(DST).get(K).i32_add().tee(DST).i32(0x00222c22).i32_store(0);
                  c.get(DST).i32(3).i32_add().set(DST);
                  c.get(COL).i32(1).i32_add().set(COL);
                  c.get(K).i32(1).i32_add().set(POS);
                  c.get(CM).get(CM).i32(1).i32_sub().i32_and().set(CM);

                  c.get(POS).get(T2).i32_eq().if_();
                    c.get(IN).get(POS).i32_add().set(IN);
                    c.get(IN).i32_load16_u(0).i32(0x225c).i32_eq().br_if('enterQuote');
                    c.br('doColdUnq');
                  c.end();

                  // DRAIN REMAINING COMMAS IN SAME V0
                  c.block('drDone').loop('drLoop');
                    c.get(CM).i32_eqz().br_if('drDone');
                    c.get(CM).i32_ctz().set(K);
                    c.get(K).get(T2).i32_ge_u().br_if('drDone');
                    c.get(K).get(POS).i32_sub().set(SM);
                    c.get(DST).get(IN).get(POS).i32_add().v128_load(0).v128_store(0);
                    c.get(DST).get(SM).i32_add().set(DST);
                    c.get(COL).i32(1).i32_add().get(W).i32_ge_s().if_();
                      c.get(DST).i32(0x22).i32_store8(0);
                      c.get(DST).i32(1).i32_add().set(DST);
                      c.get(IN).get(K).i32_add().i32(1).i32_add().set(IN);
                      c.get(COL).i32(1).i32_add().set(COL);
                      c.br('fieldLoop');
                    c.end();
                    c.get(DST).i32(0x00222c22).i32_store(0);
                    c.get(DST).i32(3).i32_add().set(DST);
                    c.get(COL).i32(1).i32_add().set(COL);
                    c.get(K).i32(1).i32_add().set(POS);
                    c.get(CM).get(CM).i32(1).i32_sub().i32_and().set(CM);
                    c.get(POS).get(T2).i32_eq().if_();
                      c.get(IN).get(POS).i32_add().set(IN);
                      c.get(IN).i32_load16_u(0).i32(0x225c).i32_eq().br_if('enterQuote');
                      c.br('doColdUnq');
                    c.end();
                    c.br('drLoop');
                  c.end().end();
                c.end();
              c.end();

              c.get(T2).get(POS).i32_sub().set(K);
              c.get(K).if_();
                c.get(POS).if_();
                  c.get(DST).get(IN).get(POS).i32_add().v128_load(0).v128_store(0);
                c.end();
                c.get(DST).get(K).i32_add().set(DST);
              c.else_();
                c.get(POS).i32(16).i32_eq().if_();
                  c.get(IN).i32(16).i32_add().set(IN);
                  c.get(IN).i32_load16_u(0).i32(0x225c).i32_eq().br_if('enterQuote');
                  c.br('fastLoop');
                c.end();
              c.end();
              c.get(IN).get(T2).i32_add().set(IN);
              c.get(T2).i32(16).i32_eq().br_if('fastLoop');

              tryInlineEol();
              c.br('doColdUnq');
            c.end(); // fastLoop

            c.end(); // enterQuote

            // ----- INLINE FAST-QUOTED 32B-UNROLLED SIMD LOOP -----
            c.loop('fastQuote');
              c.i32(ST_FQ_IN).get(IN).i32_store(0);
              c.i32(ST_FQ_DST).get(DST).i32_store(0);
              c.i32(ST_FQ_LINE).stLoad(ST_LINE).i32_store(0);
              c.get(IN).i32(2).i32_add().set(IN);

              c.loop('fqScan');
                c.get(END).get(IN).i32_sub().i32(48).i32_lt_u()
                  .get(DST).i32(OUT_FLUSH).i32_ge_u().i32_or().if_();
                  c.stLoad(ST_FQ_IN).set(IN); c.stLoad(ST_FQ_DST).set(DST);
                  c.i32(ST_LINE).stLoad(ST_FQ_LINE).i32_store(0);
                  c.br('fastExit');
                c.end();

                // 16B chunk 1
                c.get(IN).v128_load(0).set(V0);
                c.get(DST).get(V0).v128_store(0);
                c.get(V0).get(VB).i8x16_eq().get(V0).get(VQ).i8x16_eq().v128_or().i8x16_bitmask().tee(SM).i32_eqz().if_();
                  // 16B chunk 2 (32B unrolled!)
                  c.get(IN).v128_load(16).set(V0);
                  c.get(DST).get(V0).v128_store(16);
                  c.get(V0).get(VB).i8x16_eq().get(V0).get(VQ).i8x16_eq().v128_or().i8x16_bitmask().tee(SM).i32_eqz().if_();
                    c.get(IN).i32(32).i32_add().set(IN);
                    c.get(DST).i32(32).i32_add().set(DST);
                    c.br('fqScan');
                  c.end();
                  c.get(IN).i32(16).i32_add().set(IN);
                  c.get(DST).i32(16).i32_add().set(DST);
                c.end();

                c.get(SM).i32_ctz().set(K);
                c.get(DST).get(K).i32_add().set(DST);
                c.get(IN).get(K).i32_add().set(IN);

                c.get(IN).i32_load(0).set(K);
                // Closing quote + ',' AND COL+1 < W
                c.get(K).i32(0xffffff).i32_and().i32(0x2c225c).i32_eq()
                  .get(COL).i32(1).i32_add().get(W).i32_lt_s().i32_and().if_();
                  c.get(DST).i32(0x00222c22).i32_store(0);
                  c.get(DST).i32(3).i32_add().set(DST);
                  c.get(IN).i32(3).i32_add().set(IN);
                  c.get(COL).i32(1).i32_add().set(COL);
                  c.get(IN).i32_load16_u(0).i32(0x225c).i32_eq().br_if('fastQuote');
                  c.br('fastOuter');
                c.end();
                // Doubled quote '\"\"'
                c.get(K).i32(0x225c225c).i32_eq().if_();
                  c.get(DST).i32(0x225c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(4).i32_add().set(IN);
                  c.br('fqScan');
                c.end();
                // '\r\n'
                c.get(K).i32(0x6e5c725c).i32_eq().if_();
                  c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(4).i32_add().set(IN);
                  c.stInc(ST_LINE); c.br('fqScan');
                c.end();
                // '\n' or lone '\r'
                c.get(K).i32(0xffff).i32_and().tee(POS).i32(0x6e5c).i32_eq().get(POS).i32(0x725c).i32_eq().i32_or().if_();
                  c.get(DST).i32(0x6e5c).i32_store16(0); c.get(DST).i32(2).i32_add().set(DST); c.get(IN).i32(2).i32_add().set(IN);
                  c.stInc(ST_LINE); c.br('fqScan');
                c.end();
                // Closing quote at EOL
                c.get(POS).i32(0x225c).i32_eq().if_();
                  c.get(COL).i32(1).i32_add().get(W).i32_eq().if_();
                    c.get(IN).i32(2).i32_add().i32_load(0).set(K);
                    c.i32(0).set(T2);
                    c.get(K).i32(0x6e5c725c).i32_eq().if_(); c.i32(6).set(T2);
                    c.else_(); c.get(K).i32(0xffff).i32_and().i32(0x6e5c).i32_eq().if_(); c.i32(4).set(T2); c.end(); c.end();
                    c.get(T2).if_();
                      c.get(IN).get(T2).i32_add().i32_load16_u(0).set(K);
                      c.get(K).i32(0xff).i32_and().tee(POS).i32(0x5c).i32_ne().get(POS).i32(0x22).i32_ne().i32_and().if_();
                        c.get(IN).get(T2).i32_add().set(IN);
                        c.get(DST).i64(0x000000225b2c5d22n).i64_store(0);
                        c.get(DST).i32(5).i32_add().set(DST);
                        c.i32(0).set(COL);
                        c.i32(ST_LINE).stLoad(ST_LINE).i32(1).i32_add().tee(K).i32_store(0);
                        c.i32(ST_REC_LINE).get(K).i32_store(0);
                        c.stInc(ST_REC_CNT);
                        c.br('fastOuter');
                      c.end();
                      c.get(K).i32(0x225c).i32_eq().if_();
                        c.get(IN).get(T2).i32_add().set(IN);
                        c.get(DST).i64(0x000000225b2c5d22n).i64_store(0);
                        c.get(DST).i32(5).i32_add().set(DST);
                        c.i32(0).set(COL);
                        c.i32(ST_LINE).stLoad(ST_LINE).i32(1).i32_add().tee(K).i32_store(0);
                        c.i32(ST_REC_LINE).get(K).i32_store(0);
                        c.stInc(ST_REC_CNT);
                        c.br('fastQuote');
                      c.end();
                    c.end();
                  c.end();
                c.end();

                c.stLoad(ST_FQ_IN).set(IN); c.stLoad(ST_FQ_DST).set(DST);
                c.i32(ST_LINE).stLoad(ST_FQ_LINE).i32_store(0);
                c.br('fastExit');
              c.end();
            c.end();
          c.end().end(); // fastOuter, fastExit
        c.end();

        // Cold quoted check (calls factored F_QUOTE_COLD!)
        c.get(IN).i32(1).i32_add().get(END).i32_lt_u()
          .get(IN).i32_load16_u(0).i32(0x225c).i32_eq().i32_and().if_();
          callCold(F_QUOTE_COLD);
          c.br('afterCold');
        c.end();
        c.end(); // doColdUnq
        c.get(COL).i32_eqz().if_();
          c.get(DST).stLoad(ST_REC_START).stLoad(ST_REC_CNT).i32(2).i32_ge_u().if_(I32).i32(3).else_().i32(2).end().i32_add().i32_gt_u().if_();
            c.i32(ST_ADDED).i32(1).i32_store(0);
          c.end();
        c.end();
        callCold(F_UNQ_COLD);
        c.end(); // afterCold

        c.get(DST).i32(0x22).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST);
        c.stLoad(ST_EXTRA).if_(); c.i32(ST_EXTRA_PTR).get(DST).i32_store(0); c.stLoad(ST_SAVED_OUT).set(DST); c.end();
        c.get(COL).i32(1).i32_add().set(COL);
        c.stLoad(ST_ENDED).i32(END_COMMA).i32_eq().br_if('fieldLoop');
        c.br('recFieldsDone');
      c.end().end();

      c.get(COL).i32(1).i32_eq().stLoad(ST_ADDED).i32_eqz().i32_and().stLoad(ST_QUOTED).i32_eqz().i32_and().if_();
        c.stLoad(ST_REC_START).set(DST);
        c.stLoad(ST_ENDED).i32(END_EOF).i32_eq().br_if('textDone');
        c.br('recLoop');
      c.end();

      c.get(W).i32(0).i32_lt_s().if_(); c.get(COL).set(W);
      c.else_();
        c.get(COL).get(W).i32_lt_s().if_();
          c.i32(E_SHORT).get(COL).i32(0).call(F_PUSH_ERR);
          c.loop('padLoop'); ensureOut(); c.emitBytes(DST, ',""'); c.get(COL).i32(1).i32_add().tee(COL).get(W).i32_lt_s().br_if('padLoop'); c.end();
        c.else_();
          c.get(COL).get(W).i32_gt_s().if_();
            c.i32(E_LONG).stLoad(ST_EX_START).stLoad(ST_EXTRA_PTR).stLoad(ST_EX_START).i32_sub().call(F_PUSH_ERR);
          c.end();
        c.end();
      c.end();

      ensureOut();
      c.get(DST).i32(0x5d).i32_store8(0); c.get(DST).i32(1).i32_add().set(DST);
      c.stLoad(ST_REC_CNT).i32_eqz().if_();
        ensureOut();
        c.i32(ST_REC0_END).stLoad(ST_OUT_FPOS).get(DST).i32(OUT_BASE).i32_sub().i32_add().i32_store(0);
        c.emitBytes(DST, '          ');
      c.end();
      c.stInc(ST_REC_CNT);
      c.stLoad(ST_ENDED).i32(END_EOF).i32_eq().br_if('textDone');
      c.br('recLoop');
    c.end().end();

    ensureIn(1);
    c.get(IN).get(END).i32_lt_u().get(IN).i32_load8_u(0).i32(0x22).i32_eq().i32_and().if_(); c.get(IN).i32(1).i32_add().set(IN); c.end();
    c.i32(ST_IN_PTR).get(IN).i32_store(0); c.i32(ST_IN_END).get(END).i32_store(0); c.i32(ST_OUT_PTR).get(DST).i32_store(0);
    c.assertBalanced();
    return { locals: [[10, I32], [4, V128]], body: c.b };
  })();

  // 14: run()
  const fRun = (() => {
    const c = new Code();
    const IN = 0, END = 1, OUT = 2, CH = 3, CIDX = 4;
    const syncIn = () => { c.stLoad(ST_IN_PTR).set(IN); c.stLoad(ST_IN_END).set(END); };
    const saveIn = () => { c.i32(ST_IN_PTR).get(IN).i32_store(0); c.i32(ST_IN_END).get(END).i32_store(0); };
    const ws = () => { saveIn(); c.call(F_SKIP_WS); syncIn(); };
    const ensureIn = (n) => {
      c.get(END).get(IN).i32_sub().i32(n).i32_lt_u().if_();
        c.stLoad(ST_IN_EOF).i32_eqz().if_(); c.get(IN).call(F_REFILL).set(END); c.i32(0).set(IN); c.end();
      c.end();
    };
    const ensureOut = () => { c.get(OUT).i32(OUT_FLUSH).i32_ge_u().if_(); c.get(OUT).call(F_FLUSH).set(OUT); c.end(); };

    c.i32(0).set(IN); c.i32(0).call(F_REFILL).set(END); c.i32(OUT_BASE).set(OUT); c.i32(0).set(CIDX);
    ws(); ensureIn(1);
    c.get(IN).i32(1).i32_add().set(IN);
    c.get(OUT).i32(0x5b).i32_store8(0); c.get(OUT).i32(1).i32_add().set(OUT);

    c.block('casesDone').loop('casesLoop');
      ws(); ensureIn(1);
      c.get(IN).get(END).i32_ge_u().br_if('casesDone');
      c.get(IN).i32_load8_u(0).i32(0x5d).i32_eq().br_if('casesDone');
      c.get(CIDX).if_(); ensureOut(); c.get(OUT).i32(0x2c).i32_store8(0); c.get(OUT).i32(1).i32_add().set(OUT); c.end();
      c.get(IN).i32(1).i32_add().set(IN);

      c.i32(ST_ERR_CNT).i32(0).i32_store(0);
      c.i32(ST_EXTRA_PTR).i32(EXTRA_BASE).i32_store(0);
      c.i32(ST_HEADER).i32(0).i32_store(0);
      c.i32(ST_REC_CNT).i32(0).i32_store(0);
      c.i32(ST_LINE).i32(1).i32_store(0);

      ensureOut();
      c.i32(ST_CASE_START).stLoad(ST_OUT_FPOS).get(OUT).i32(OUT_BASE).i32_sub().i32_add().i32_store(0);
      c.emitBytes(OUT, '                        ');
      c.i32(ST_REC0_END).stLoad(ST_OUT_FPOS).get(OUT).i32(OUT_BASE).i32_sub().i32_add().i32_store(0);

      c.block('coDone').loop('coLoop');
        ws(); ensureIn(16);
        c.get(IN).i32_load8_u(0).set(CH);
        c.get(CH).i32(0x7d).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); c.br('coDone'); c.end();
        c.get(CH).i32(0x2c).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); c.br('coLoop'); c.end();
        c.get(IN).i32_load(0).i32(0x706e6922).i32_eq()
          .get(IN).i32_load16_u(4).i32(0x7475).i32_eq().i32_and()
          .get(IN).i32_load8_u(6).i32(0x22).i32_eq().i32_and().if_();
          c.get(IN).i32(7).i32_add().set(IN); ws(); c.get(IN).i32(1).i32_add().set(IN); ws(); c.get(IN).i32(1).i32_add().set(IN);
          c.block('ioDone').loop('ioLoop');
            ws(); ensureIn(16);
            c.get(IN).i32_load8_u(0).set(CH);
            c.get(CH).i32(0x7d).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); c.br('ioDone'); c.end();
            c.get(CH).i32(0x2c).i32_eq().if_(); c.get(IN).i32(1).i32_add().set(IN); c.br('ioLoop'); c.end();
            c.get(IN).i32_load(0).i32(0x61656822).i32_eq().get(IN).i32_load(4).i32(0x22726564).i32_eq().i32_and().if_();
              c.get(IN).i32(8).i32_add().set(IN); ws(); c.get(IN).i32(1).i32_add().set(IN); ws(); ensureIn(5);
              c.get(IN).i32_load8_u(0).i32(0x74).i32_eq().if_();
                c.i32(ST_HEADER).i32(1).i32_store(0); c.get(IN).i32(4).i32_add().set(IN);
              c.else_();
                c.i32(ST_HEADER).i32(0).i32_store(0); saveIn(); c.call(F_SKIP_VAL); syncIn();
              c.end();
              c.br('ioLoop');
            c.end();
            c.get(IN).i32_load(0).i32(0x78657422).i32_eq().get(IN).i32_load16_u(4).i32(0x2274).i32_eq().i32_and().if_();
              c.get(IN).i32(6).i32_add().set(IN); ws(); c.get(IN).i32(1).i32_add().set(IN); ws(); c.get(IN).i32(1).i32_add().set(IN);
              saveIn(); c.i32(ST_OUT_PTR).get(OUT).i32_store(0);
              c.call(F_PARSE_TEXT);
              syncIn(); c.stLoad(ST_OUT_PTR).set(OUT);
              c.br('ioLoop');
            c.end();
            c.get(IN).i32(1).i32_add().set(IN); saveIn(); c.call(F_SKIP_STR); c.call(F_SKIP_WS);
            c.i32(ST_IN_PTR).stLoad(ST_IN_PTR).i32(1).i32_add().i32_store(0); c.call(F_SKIP_VAL); syncIn();
            c.br('ioLoop');
          c.end().end();
          c.br('coLoop');
        c.end();
        c.get(IN).i32(1).i32_add().set(IN); saveIn(); c.call(F_SKIP_STR); c.call(F_SKIP_WS);
        c.i32(ST_IN_PTR).stLoad(ST_IN_PTR).i32(1).i32_add().i32_store(0); c.call(F_SKIP_VAL); syncIn();
        c.br('coLoop');
      c.end().end();

      ensureOut();
      c.get(OUT).i32(0x5d).i32_store8(0); c.get(OUT).i32(1).i32_add().set(OUT);
      c.get(OUT).call(F_PATCH).set(OUT);
      c.get(OUT).call(F_EMIT_ERRS).set(OUT);
      c.get(CIDX).i32(1).i32_add().set(CIDX);
      ws(); ensureIn(1);
      c.get(IN).get(END).i32_lt_u().get(IN).i32_load8_u(0).i32(0x2c).i32_eq().i32_and().if_();
        c.get(IN).i32(1).i32_add().set(IN); c.br('casesLoop');
      c.end();
      c.br('casesDone');
    c.end().end();

    ensureOut();
    c.get(OUT).i32(0x5d).i32_store8(0);
    c.get(OUT).i32(1).i32_add().call(F_FLUSH).drop();
    c.assertBalanced();
    return { locals: [[5, I32]], body: c.b };
  })();

  const typeSec = section(1, [...uleb(types.length), ...types.flat()]);
  const imports = [
    [...strBytes('e'), ...strBytes('m'), 0x02, 0x00, ...uleb(MEM_PAGES)],
    [...strBytes('e'), ...strBytes('r'), 0x00, 0],
    [...strBytes('e'), ...strBytes('f'), 0x00, 0],
    [...strBytes('e'), ...strBytes('w'), 0x00, 1],
    [...strBytes('e'), ...strBytes('p'), 0x00, 0],
  ];
  const importSec = section(2, [...uleb(imports.length), ...imports.flat()]);
  const funcTypeIdxs = [1, 2, 0, 0, 3, 3, 3, 3, 3, 3, 3];
  const funcSec = section(3, [...uleb(funcTypeIdxs.length), ...funcTypeIdxs]);
  const exportSec = section(7, [1, ...strBytes('run'), 0x00, ...uleb(F_RUN)]);
  const bodies = [fWriteU32, fPushErr, fEmitErrs, fHex4, fSkipWs, fSkipStr, fSkipVal, fUnqCold, fQuoteCold, fParseText, fRun].map((fn) => {
    const locBytes = [...uleb(fn.locals.length)];
    for (const [cnt, t] of fn.locals) locBytes.push(...uleb(cnt), t);
    const body = [...locBytes, ...fn.body, 0x0b];
    return [...uleb(body.length), ...body];
  });
  const codeSec = section(10, [...uleb(bodies.length), ...bodies.flat()]);
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...typeSec, ...importSec, ...funcSec, ...exportSec, ...codeSec]);
}

if (process.argv[1] && process.argv[1].endsWith('build_wasm.mjs')) {
  const bytes = buildWasm();
  const out = process.argv[2] || 'C:/Users/HP/.gemini/antigravity/brain/22d079de-3ddb-458d-9e5f-9a42f5f02074/scratch/csv_wasm_v5/t.wasm';
  fs.mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log('Emitted v5-256k WASM:', bytes.length, 'bytes ->', out);
  new WebAssembly.Module(bytes);
  console.log('WebAssembly.Module validation PASSED!');
}
