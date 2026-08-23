from pathlib import Path

p = Path('vendor/qrcode.js')
s = p.read_text()

old = '''    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        for (let i = 0; i < length; i++) {
          this.putBit((num >>> length - i - 1 & 1) === 1);
        }
      },
'''
new = '''    BitBuffer.prototype = {
      get: function(index) {
        const bufIndex = Math.floor(index / 8);
        return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
      },
      put: function(num, length) {
        while (length > 0) {
          const bufIndex = this.length >>> 3;
          const used = this.length & 7;
          if (this.buffer.length <= bufIndex) this.buffer.push(0);
          const room = 8 - used;
          const take = Math.min(room, length);
          const shift = length - take;
          const mask = (1 << take) - 1;
          this.buffer[bufIndex] |= (num >>> shift & mask) << room - take;
          this.length += take;
          length -= take;
        }
      },
'''
if old not in s: raise SystemExit('BitBuffer block mismatch')
s = s.replace(old, new, 1)

old = '''      } else {
        this.data = new Uint8Array(data);
      }
'''
new = '''      } else if (data instanceof Uint8Array) {
        this.data = data;
      } else if (ArrayBuffer.isView(data)) {
        this.data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        this.data = new Uint8Array(data);
      }
'''
if old not in s: raise SystemExit('ByteData block mismatch')
s = s.replace(old, new, 1)

old = '''    exports.mod = function mod(divident, divisor) {
      let result = new Uint8Array(divident);
      while (result.length - divisor.length >= 0) {
        const coeff = result[0];
        for (let i = 0; i < divisor.length; i++) {
          result[i] ^= GF.mul(divisor[i], coeff);
        }
        let offset = 0;
        while (offset < result.length && result[offset] === 0) offset++;
        result = result.slice(offset);
      }
      return result;
    };
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      return poly;
    };
'''
new = '''    exports.mod = function mod(divident, divisor) {
      const result = new Uint8Array(divident);
      let offset = 0;
      while (result.length - offset >= divisor.length) {
        const coeff = result[offset];
        if (coeff !== 0) {
          for (let i = 0; i < divisor.length; i++) {
            result[offset + i] ^= GF.mul(divisor[i], coeff);
          }
        }
        while (offset < result.length && result[offset] === 0) offset++;
      }
      return result.slice(offset);
    };
    const ecPolynomialCache = /* @__PURE__ */ new Map();
    exports.generateECPolynomial = function generateECPolynomial(degree) {
      const cached = ecPolynomialCache.get(degree);
      if (cached) return cached;
      let poly = new Uint8Array([1]);
      for (let i = 0; i < degree; i++) {
        poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
      }
      ecPolynomialCache.set(degree, poly);
      return poly;
    };
'''
if old not in s: raise SystemExit('Polynomial block mismatch')
s = s.replace(old, new, 1)

old = '        dcData[b] = buffer.slice(offset, offset + dataSize);'
if old not in s: raise SystemExit('RS data slice mismatch')
s = s.replace(old, '        dcData[b] = buffer.subarray(offset, offset + dataSize);', 1)
p.write_text(s)

p = Path('version.js')
s = p.read_text()
if 'APP_VERSION = "0.5.381"' not in s: raise SystemExit('unexpected version')
p.write_text(s.replace('APP_VERSION = "0.5.381"', 'APP_VERSION = "0.5.382"', 1))
