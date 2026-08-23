from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing {label}")
    return text.replace(old, new, 1)

# Root runtime: don't parse the half-megabyte receiver until Receive is opened.
p = Path("main.js")
s = p.read_text()
s = s.replace('import "./receive/phase-nudge.js";\nimport "./receive/auto-phase.js";\n', '', 1)
s = replace_once(s,
'''await prepareServiceWorker();
await Promise.all([
  import(`./send/main.js?build=${APP_BUILD}`),
  import(`./receive/main.js?build=${APP_BUILD}`)
]);

''',
'''void prepareServiceWorker();
await import(`./send/main.js?build=${APP_BUILD}`);
let receiveModulePromise;
let receiveModuleLoaded = false;
function ensureReceiveModule() {
  if (!receiveModulePromise) {
    receiveModulePromise = import(`./receive/main.js?build=${APP_BUILD}`).then((module) => {
      receiveModuleLoaded = true;
      return module;
    });
  }
  return receiveModulePromise;
}

''', 'eager module load')
start = s.find('// receive/main.js historically carried its own diagnostic-only build constant.')
end = s.find('if (serviceWorkers) {', start)
if start < 0 or end < 0:
    raise SystemExit('missing obsolete runtime diagnostics observer')
s = s[:start] + s[end:]
s = replace_once(s, 'let active = "home";\n', '''let active = "home";
let receiveLoadDispatchQueued = false;
function dispatchReceiveWhenReady(type = "airgapper:enter-receive") {
  if (receiveModuleLoaded) {
    if (active === "receive") window.dispatchEvent(new CustomEvent(type));
    return;
  }
  if (receiveLoadDispatchQueued) return;
  receiveLoadDispatchQueued = true;
  void ensureReceiveModule().then(() => {
    receiveLoadDispatchQueued = false;
    if (active === "receive") window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
  }).catch(() => {
    receiveLoadDispatchQueued = false;
  });
}
''', 'receive lazy-dispatch helper')
s = replace_once(s,
'  if (name === "receive") window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));\n',
'  if (name === "receive") dispatchReceiveWhenReady();\n', 'receive enter dispatch')
s = replace_once(s,
'  window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));\n};\nfunction resumeActiveView() {',
'  if (receiveModuleLoaded) window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));\n};\nfunction resumeActiveView() {', 'lazy receive pause')
s = replace_once(s,
'''  if (suspended) {
    suspended = false;
    window.dispatchEvent(new CustomEvent("airgapper:resume-mode"));
  } else if (receiveNeedsCamera()) {
    window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
  }
''',
'''  if (suspended) {
    suspended = false;
    dispatchReceiveWhenReady(receiveModuleLoaded ? "airgapper:resume-mode" : "airgapper:enter-receive");
  } else if (receiveNeedsCamera()) {
    dispatchReceiveWhenReady();
  }
''', 'lazy receive resume')
p.write_text(s)

# Receiver developer-only phase tooling should not run on every scan.
p = Path("receive/main.js")
s = p.read_text()
needle = 'const receiverDevActions = document.querySelector(".receiver-dev-actions");\n'
s = replace_once(s, needle, needle + '''let receiverDevToolsPromise;
function loadReceiverDevTools() {
  if (!receiverDevToolsPromise) {
    // auto-phase reads controls created by phase-nudge, so preserve order.
    receiverDevToolsPromise = import("./phase-nudge.js").then(() => import("./auto-phase.js"));
  }
  return receiverDevToolsPromise;
}
''', 'receiver dev tool loader')
s = replace_once(s,
'''  if (receiverSettings.open && settingsToggleTimes.length >= 3) {
    receiverDevActions.hidden = false;
    rememberDeveloperModeUse();
  }
''',
'''  if (receiverSettings.open && settingsToggleTimes.length >= 3) {
    receiverDevActions.hidden = false;
    void loadReceiverDevTools();
    rememberDeveloperModeUse();
  }
''', 'developer reveal')
s = s.replace('new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen)',
              'new TransportDecoder(header.k, header.blockLen, header.totalLen)', 1)
p.write_text(s)

# Sender: remove obsolete rebuilds/allocations from the hot page pipeline.
p = Path("send/main.js")
s = p.read_text()
s = replace_once(s,
'''function applyLiveSenderFps() {
  if (isAutoLayout()) return false;
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}
''',
'''function applyLiveSenderFps() {
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}
''', 'live Auto FPS')
s = replace_once(s,
'''      const previousMeasuredHz = measuredDisplayHz;
      measuredDisplayHz = Math.max(30, refreshRate);
      if (selectedFile && isAutoLayout() && Math.abs(previousMeasuredHz - measuredDisplayHz) >= 1) {
        clearTimeout(autoGridRefreshTimer);
        autoGridRefreshTimer = setTimeout(() => void startStream(), 120);
      }
''',
'''      measuredDisplayHz = Math.max(30, refreshRate);
''', 'refresh rebuild')
s = replace_once(s,
'''    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId
  };
''',
'''    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId,
    seq: 0,
    slotIndex: 0
  };
''', 'mutable frame header')
s = s.replace('new TransportEncoder(payload, blockLen, payloadId, transport.mode)',
              'new TransportEncoder(payload, blockLen, transport.mode)', 1)
s = replace_once(s,
'''    const bytes = packFrame(
      { ...header, seq, slotIndex },
      encoder.encode(seq)
    );
''',
'''    header.seq = seq;
    header.slotIndex = slotIndex;
    const bytes = packFrame(header, encoder.encode(seq));
''', 'main-thread frame header spread')
s = replace_once(s,
'''    const readyPages = new Map();
    const pageMeta = new Map();
''',
'''    const readyPages = new Map();
''', 'page metadata map')
s = s.replace('      pageMeta.clear();\n', '', 1)
s = replace_once(s,
'''      pageMeta.set(pageId, { startOrdinal, endOrdinal: startOrdinal + gridCodes });
      try {
''',
'''      try {
''', 'page metadata set')
s = replace_once(s,
'''        const bytes = packFrame({ ...header, seq, slotIndex }, encoder.encode(seq));
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
''',
'''        header.seq = seq;
        header.slotIndex = slotIndex;
        const bytes = packFrame(header, encoder.encode(seq));
        const buffer = bytes.buffer;
''', 'worker frame header/copy')
s = replace_once(s,
'''          pageId,
          frames,
''',
'''          pageId,
          startOrdinal,
          frames,
''', 'worker start ordinal')
s = s.replace('        pageMeta.delete(pageId);\n', '', 1)
s = replace_once(s,
'''        const meta = pageMeta.get(page?.pageId);
        if (!meta || page?.type !== "rendered-page") {
          closePage(page);
          fail(new Error("Sender QR worker returned an invalid page"));
          return;
        }
        readyPages.set(page.pageId, { ...page, ...meta });
''',
'''        if (page?.type !== "rendered-page" || !Number.isInteger(page.startOrdinal) || !Number.isInteger(page.endOrdinal)) {
          closePage(page);
          fail(new Error("Sender QR worker returned an invalid page"));
          return;
        }
        readyPages.set(page.pageId, page);
''', 'worker page merge')
s = s.replace('      pageMeta.delete(nextPresentPageId);\n', '', 1)
# Remove the permanently-disabled diagnostics payload and its object churn.
start = s.find('      if (false) {\n        void fetch("/__diagnostics"')
if start < 0:
    raise SystemExit('missing dead sender diagnostics block')
i = s.find('{', start)
depth = 0
while i < len(s):
    if s[i] == '{': depth += 1
    elif s[i] == '}':
        depth -= 1
        if depth == 0:
            i += 1
            if i < len(s) and s[i] == '\n': i += 1
            s = s[:start] + s[i:]
            break
    i += 1
else:
    raise SystemExit('unterminated sender diagnostics block')
p.write_text(s)

# Render worker returns page ordinals directly; no side Map is needed on main.
p = Path("send/render-worker.js")
s = p.read_text()
s = replace_once(s,
'''    const common = { type: "rendered-page", pageId: job.pageId, version, modules, width, height };
''',
'''    const startOrdinal = Number(job.startOrdinal);
    const common = {
      type: "rendered-page",
      pageId: job.pageId,
      startOrdinal,
      endOrdinal: startOrdinal + job.frames.length,
      version,
      modules,
      width,
      height
    };
''', 'render page metadata')
p.write_text(s)

# Generic qrcode package: specialize the explicit byte/version path used by AirGapper.
p = Path("vendor/qrcode.js")
s = p.read_text()
s = replace_once(s,
'''    function BitBuffer() {
      this.buffer = [];
      this.length = 0;
    }
''',
'''    function BitBuffer(capacityBytes) {
      this.buffer = new Uint8Array(capacityBytes);
      this.length = 0;
    }
''', 'typed bit buffer')
s = s.replace('          if (this.buffer.length <= bufIndex) this.buffer.push(0);\n', '', 1)
s = replace_once(s,
'''      putBit: function(bit) {
        const bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) {
          this.buffer.push(0);
        }
        if (bit) {
          this.buffer[bufIndex] |= 128 >>> this.length % 8;
        }
        this.length++;
      }
''',
'''      putBit: function(bit) {
        const bufIndex = this.length >>> 3;
        if (bit) this.buffer[bufIndex] |= 128 >>> (this.length & 7);
        this.length++;
      },
      putBytes: function(bytes) {
        const used = this.length & 7;
        let dst = this.length >>> 3;
        if (used === 0) {
          this.buffer.set(bytes, dst);
          this.length += bytes.length * 8;
          return;
        }
        for (let i = 0; i < bytes.length; i++) {
          const value = bytes[i];
          this.buffer[dst] |= value >>> used;
          this.buffer[++dst] = value << (8 - used) & 255;
        }
        this.length += bytes.length * 8;
      }
''', 'bit buffer byte write')
s = replace_once(s,
'''    ByteData.prototype.write = function(bitBuffer) {
      for (let i = 0, l = this.data.length; i < l; i++) {
        bitBuffer.put(this.data[i], 8);
      }
    };
''',
'''    ByteData.prototype.write = function(bitBuffer) {
      bitBuffer.putBytes(this.data);
    };
''', 'byte segment bulk write')
s = replace_once(s,
'''    function buildSingleSegment(data, modesHint) {
      let mode;
      const bestMode = Mode.getBestModeForData(data);
      mode = Mode.from(modesHint, bestMode);
''',
'''    function buildSingleSegment(data, modesHint) {
      let mode = Mode.from(modesHint);
      if (mode === Mode.BYTE) return new ByteData(data);
      const bestMode = Mode.getBestModeForData(data);
      mode = mode || bestMode;
''', 'explicit byte mode detection')
s = replace_once(s,
'''    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
''',
'''    exports.canFitData = function canFitData(data, version, errorCorrectionLevel) {
      const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
      if (Array.isArray(data)) {
        if (data.length > 1) {
          return getTotalBitsFromDataArray(data, version) <= exports.getCapacity(version, ecl, Mode.MIXED);
        }
        if (data.length === 0) return true;
        data = data[0];
      }
      return data.getLength() <= exports.getCapacity(version, ecl, data.mode);
    };
    exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
''', 'single-version capacity check')
s = replace_once(s,
'''    exports.mod = function mod(divident, divisor) {
      const result = new Uint8Array(divident);
''',
'''    exports.mod = function mod(divident, divisor) {
      const result = divident;
''', 'in-place polynomial division')
s = s.replace('      return result.slice(offset);\n', '      return result.subarray(offset);\n', 1)
s = replace_once(s,
'''    function createData(version, errorCorrectionLevel, segments) {
      const buffer = new BitBuffer();
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
''',
'''    function createData(version, errorCorrectionLevel, segments) {
      const totalCodewords = Utils.getSymbolTotalCodewords(version);
      const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
      const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
      const buffer = new BitBuffer(dataTotalCodewordsBits >>> 3);
      segments.forEach(function(data) {
        buffer.put(data.mode.bit, 4);
        buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
        data.write(buffer);
      });
''', 'preallocated QR data buffer')
s = replace_once(s,
'''      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      for (let i = 0; i < remainingByte; i++) {
        buffer.put(i % 2 ? 17 : 236, 8);
      }
''',
'''      const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
      let pad = buffer.getLengthInBits() >>> 3;
      for (let i = 0; i < remainingByte; i++) buffer.buffer[pad + i] = i % 2 ? 17 : 236;
      buffer.length += remainingByte * 8;
''', 'direct QR padding fill')
s = replace_once(s,
'''    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
''',
'''    const rsEncoderCache = /* @__PURE__ */ new Map();
    function createCodewords(bitBuffer, version, errorCorrectionLevel) {
''', 'RS encoder cache')
s = replace_once(s,
'''      const rs = new ReedSolomonEncoder(ecCount);
''',
'''      let rs = rsEncoderCache.get(ecCount);
      if (!rs) {
        rs = new ReedSolomonEncoder(ecCount);
        rsEncoderCache.set(ecCount, rs);
      }
''', 'cached RS encoder')
s = s.replace('      const buffer = new Uint8Array(bitBuffer.buffer);\n', '      const buffer = bitBuffer.buffer;\n', 1)
s = replace_once(s,
'''      const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
      if (!bestVersion) {
        throw new Error("The amount of data is too big to be stored in a QR Code");
      }
      if (!version) {
        version = bestVersion;
      } else if (version < bestVersion) {
        throw new Error(
          "\\nThe chosen QR Code version cannot contain this amount of data.\\nMinimum version required to store current data is: " + bestVersion + ".\\n"
        );
      }
''',
'''      if (version) {
        if (!Version.canFitData(segments, version, errorCorrectionLevel)) {
          throw new Error("The chosen QR Code version cannot contain this amount of data.");
        }
      } else {
        version = Version.getBestVersionForData(segments, errorCorrectionLevel);
        if (!version) throw new Error("The amount of data is too big to be stored in a QR Code");
      }
''', 'explicit version validation')
p.write_text(s)

# File protocol: eliminate whole-file copies that add no ownership or safety.
p = Path("shared/protocol.js")
s = p.read_text()
s = replace_once(s,
'''async function digest(bytes) {
  const stableBytes = Uint8Array.from(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes));
}
''',
'''async function digest(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
''', 'digest copy')
s = s.replace('  const transmitted = container.slice(dataOffset);\n', '  const transmitted = container.subarray(dataOffset);\n', 1)
p.write_text(s)

# Transport cleanup: streamSeed has been dead state for a long time.
p = Path("shared/transport.js")
s = p.read_text()
s = s.replace('  constructor(payload, blockLen, streamSeed, mode) {', '  constructor(payload, blockLen, mode) {', 1)
s = s.replace('    this.streamSeed = streamSeed;\n', '', 1)
s = s.replace('  constructor(k, blockLen, streamSeed, totalLen) {', '  constructor(k, blockLen, totalLen) {', 1)
s = s.replace('    this.streamSeed = streamSeed;\n', '', 1)
s = s.replace('    var _a;\n    (_a = this.raptor) == null ? void 0 : _a.free();', '    this.raptor?.free();', 1)
s = s.replace('    var _a;\n    (_a = this.raptor) == null ? void 0 : _a.free();', '    this.raptor?.free();', 1)
p.write_text(s)

# Worker pool: activeMeta already owns per-job metadata; the second Map was pure churn.
p = Path("shared/worker-pool.js")
s = p.read_text()
s = s.replace('    this.jobOptics = /* @__PURE__ */ new Map();\n', '', 1)
s = replace_once(s,
'''      const jobOptics = this.jobOptics.get(message.id);
      this.jobOptics.delete(message.id);
      clearTimeout(this.jobTimers[slot]);
''',
'''      const jobMeta = this.activeMeta[slot];
      clearTimeout(this.jobTimers[slot]);
''', 'worker job optics map read')
s = s.replace('sourceSequence: jobOptics == null ? void 0 : jobOptics.sourceSequence,', 'sourceSequence: jobMeta?.sourceSequence,', 1)
s = s.replace('opticsEpoch: jobOptics == null ? void 0 : jobOptics.opticsEpoch,', 'opticsEpoch: jobMeta?.opticsEpoch,', 1)
s = s.replace('      if (id !== void 0) this.jobOptics.delete(id);\n', '', 1)
s = replace_once(s,
'''    this.activeMeta[slot] = {
      id: typeof id === "number" ? id : void 0,
      kind: message.jobKind ?? (message.full ? "full" : "tracked"),
      full: Boolean(message.full),
      tracks: Number(message.trackCount ?? message.tracks?.length ?? 0),
      pixels: Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0),
      startedAt: performance.now()
    };
    if (typeof id === "number") {
      const metadata = message;
      this.jobOptics.set(id, {
        sourceSequence: typeof metadata.sourceSequence === "number" ? metadata.sourceSequence : void 0,
        opticsEpoch: typeof metadata.opticsEpoch === "number" ? metadata.opticsEpoch : void 0
      });
    }
    try {
      if (message && typeof message === "object") message.sentAt = performance.now();
''',
'''    const startedAt = performance.now();
    this.activeMeta[slot] = {
      id: typeof id === "number" ? id : void 0,
      kind: message.jobKind ?? (message.full ? "full" : "tracked"),
      full: Boolean(message.full),
      tracks: Number(message.trackCount ?? message.tracks?.length ?? 0),
      pixels: Math.max(0, Number(message.w) || 0) * Math.max(0, Number(message.h) || 0),
      sourceSequence: typeof message.sourceSequence === "number" ? message.sourceSequence : void 0,
      opticsEpoch: typeof message.opticsEpoch === "number" ? message.opticsEpoch : void 0,
      startedAt
    };
    try {
      if (message && typeof message === "object") message.sentAt = startedAt;
''', 'worker active metadata')
s = s.replace('        this.jobOptics.delete(activeId);\n', '', 1)
s = s.replace('      if (typeof id === "number") this.jobOptics.delete(id);\n', '', 1)
p.write_text(s)

# Version text is runtime-owned; don't leave a stale hardcoded build in HTML.
p = Path("index.html")
s = p.read_text().replace('<span class="brand">AirGapper <span class="app-version">v0.5.361</span></span>', '<span class="brand">AirGapper <span class="app-version"></span></span>', 1)
p.write_text(s)

p = Path("version.js")
s = p.read_text()
s = replace_once(s, 'APP_VERSION = "0.5.384"', 'APP_VERSION = "0.5.385"', 'version')
p.write_text(s)
