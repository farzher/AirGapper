from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}")
    p.write_text(text.replace(old, new, count))


p = Path('receive/main.js')
text = p.read_text()
old = '''const uniqueQrTimes = [];
const duplicateQrTimes = [];
'''
new = '''const uniqueQrTimes = [];
const duplicateQrTimes = [];
const sourceSequencesByEsi = new Map();
const duplicateSourceDelta = { same: 0, one: 0, two: 0, later: 0, unknown: 0 };
function resetDuplicateAttribution() {
  sourceSequencesByEsi.clear();
  duplicateSourceDelta.same = 0;
  duplicateSourceDelta.one = 0;
  duplicateSourceDelta.two = 0;
  duplicateSourceDelta.later = 0;
  duplicateSourceDelta.unknown = 0;
}
function noteDuplicateAttribution(esi, sourceSequence, duplicate) {
  const sequence = Number(sourceSequence);
  const prior = sourceSequencesByEsi.get(esi) ?? [];
  if (duplicate) {
    if (!Number.isFinite(sequence) || !prior.length) {
      duplicateSourceDelta.unknown++;
    } else {
      const delta = prior.reduce((best, item) => Math.min(best, Math.abs(sequence - item)), Infinity);
      if (delta === 0) duplicateSourceDelta.same++;
      else if (delta === 1) duplicateSourceDelta.one++;
      else if (delta === 2) duplicateSourceDelta.two++;
      else duplicateSourceDelta.later++;
    }
  }
  if (Number.isFinite(sequence) && !prior.includes(sequence)) {
    prior.push(sequence);
    if (prior.length > 6) prior.shift();
    sourceSequencesByEsi.set(esi, prior);
  }
}
function duplicateSourceDeltaSummary() {
  const d = duplicateSourceDelta;
  return `Duplicate source Δ same ${d.same} · +1 ${d.one} · +2 ${d.two} · 3+ ${d.later} · unknown ${d.unknown}`;
}
'''
if text.count(old) != 1:
    raise SystemExit(f"receive/main.js: duplicate array anchor count {text.count(old)}")
text = text.replace(old, new, 1)

reset_anchor = '  duplicateQrTimes.length = 0;\n'
reset_count = text.count(reset_anchor)
if reset_count != 3:
    raise SystemExit(f"receive/main.js: expected 3 duplicate reset anchors, found {reset_count}")
text = text.replace(reset_anchor, reset_anchor + '  resetDuplicateAttribution();\n')

old_decode = '''  const framesNewBefore = decoder.framesNew;
  const usefulBefore = decoder.usefulSymbols;
  const redundantBefore = decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  const receivedAt = receiverNow();
  (decoder.framesNew === framesNewBefore ? duplicateQrTimes : uniqueQrTimes).push(receivedAt);
'''
new_decode = '''  const framesNewBefore = decoder.framesNew;
  const usefulBefore = decoder.usefulSymbols;
  const redundantBefore = decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  const receivedAt = receiverNow();
  const duplicateFrame = decoder.framesNew === framesNewBefore;
  (duplicateFrame ? duplicateQrTimes : uniqueQrTimes).push(receivedAt);
  noteDuplicateAttribution(header.seq, info?.sourceSequence, duplicateFrame);
'''
if text.count(old_decode) != 1:
    raise SystemExit(f"receive/main.js: decode attribution anchor count {text.count(old_decode)}")
text = text.replace(old_decode, new_decode, 1)

needle = 'transportDiagnostics.textContent ='
if text.count(needle) != 1:
    raise SystemExit(f"receive/main.js: expected one transport diagnostics assignment, found {text.count(needle)}")
start = text.index(needle)
end = text.find(';\n', start)
if end < 0:
    raise SystemExit('receive/main.js: could not find transport diagnostics assignment end')
assignment = text[start:end + 2]
if 'Average' not in assignment or 'Recent' not in assignment or 'Transport' not in assignment:
    raise SystemExit('receive/main.js: transport assignment did not contain expected diagnostics labels')
text = text[:end + 2] + '  transportDiagnostics.textContent += `\\n${duplicateSourceDeltaSummary()}`;\n' + text[end + 2:]
p.write_text(text)

replace_exact('index.html', 'v0.5.138', 'v0.5.139')
replace_exact('main.js', 'v0.5.138', 'v0.5.139')
replace_exact('receive/main.js', 'v0.5.138', 'v0.5.139')
replace_exact('sw.js', 'airgapper-static-js-v101', 'airgapper-static-js-v102')
