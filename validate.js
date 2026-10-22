'use strict';
const crypto = require('crypto');

// Nickname rules (mirrored in the browser): 2-16 chars, letters/digits/space/_/-/. only.
// HTML/script characters are REJECTED (never silently stripped) so what is stored is what was typed.
function checkNick(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'Nickname must be text' };
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return { ok: false, reason: 'Nickname needs at least 2 characters' };
  if (s.length > 16) return { ok: false, reason: 'Nickname can be at most 16 characters' };
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(s)) return { ok: false, reason: 'Use letters, numbers, space, _ - . only' };
  return { ok: true, nick: s };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function roomCode(len = 5) {
  const b = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
const normCode = (c) => (typeof c === 'string' ? c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '');

// Car description sent by a client: only small whitelisted fields, everything bounded.
function cleanCar(c) {
  const o = c && typeof c === 'object' ? c : {};
  const col = typeof o.col === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.col) ? o.col.toLowerCase() : '#22f0a8';
  return { id: clampInt(o.id, 0, 31, 0), sp: clampInt(o.sp, 0, 7, 0), col };
}

// Map ids a client says it can load: integers only, deduplicated, bounded.
function cleanMapList(a, allowed) {
  if (!Array.isArray(a)) return [];
  const set = new Set();
  for (const v of a.slice(0, 64)) if (Number.isInteger(v) && allowed.includes(v)) set.add(v);
  return [...set].sort((x, y) => x - y);
}

module.exports = { checkNick, isNum, clampInt, roomCode, normCode, cleanCar, cleanMapList };
