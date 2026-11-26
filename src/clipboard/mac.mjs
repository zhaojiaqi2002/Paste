// macOS clipboard watcher (JXA / ObjC bridge). Started once, runs until killed.
//
// Why JXA: NSPasteboard.changeCount is an exact change signal (no polling
// heuristics, no hashing every tick), and the ObjC bridge reaches formats that
// pbpaste cannot. Cost is ~0.3% CPU at 350ms ticks.
//
// argv: [0] = scratch directory for extracted images.
// stdout: one JSON object per line, newline delimited:
//   {"t":"text","text":"..."} | {"t":"image","path":"/..."} |
//   {"t":"files","paths":["..."]} | {"t":"none"} | {"t":"tick","cc":N}

ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  const tmpDir = argv[0] || '/tmp';
  const fh = $.NSFileHandle.fileHandleWithStandardOutput;
  const pb = $.NSPasteboard.generalPasteboard;

  function emit(obj) {
    try {
      const json = JSON.stringify(obj);
      const data = $(json + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
      fh.writeData(data);
      return true;
    } catch (e) {
      // Parent is gone (EPIPE) or bridging failed: stop quietly.
      return false;
    }
  }

  function readFiles() {
    try {
      const plist = pb.propertyListForType('NSFilenamesPboardType');
      if (!plist.isNil()) {
        const list = plist.js;
        if (list && list.length) return list.map(function (x) { return ObjC.unwrap(x); });
      }
    } catch (e) { /* not a file copy */ }
    try {
      const url = pb.stringForType('public.file-url');
      if (!url.isNil()) {
        const raw = ObjC.unwrap(url);
        if (raw && raw.indexOf('file://') === 0) {
          return [decodeURIComponent(raw.slice(7))];
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function readImage(cc) {
    const types = [['public.png', 'png'], ['public.tiff', 'tiff'], ['public.jpeg', 'jpg']];
    for (let i = 0; i < types.length; i++) {
      try {
        const data = pb.dataForType(types[i][0]);
        if (data.isNil()) continue;
        const p = tmpDir + '/clip-' + cc + '.' + types[i][1];
        if (data.writeToFileAtomically(p, true)) return { path: p, size: Number(data.length) };
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function readText() {
    try {
      const s = pb.stringForType('public.utf8-plain-text');
      if (!s.isNil()) return ObjC.unwrap(s);
    } catch (e) { /* ignore */ }
    try {
      const s = pb.stringForType('public.utf16-external-plain-text');
      if (!s.isNil()) return ObjC.unwrap(s);
    } catch (e) { /* ignore */ }
    return null;
  }

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;

  function snapshot(cc) {
    const files = readFiles();
    if (files && files.length) {
      const out = { t: 'files', paths: files.slice(0, 50) };
      // Another app's container may be unreadable to us, but the pasteboard
      // often also carries the image itself. Ship both so the parent can pick.
      if (files.some(function (p) { return IMAGE_EXT.test(p); })) {
        const image = readImage(cc);
        if (image && image.size > 0) out.image = image.path;
      }
      return out;
    }

    const image = readImage(cc);
    if (image && image.size > 0) return { t: 'image', path: image.path, bytes: image.size };

    const text = readText();
    if (typeof text === 'string') {
      if (!text.length) return { t: 'none' };
      return { t: 'text', text: text };
    }
    return { t: 'none' };
  }

  // Capture whatever is already on the clipboard once, then follow changes.
  let last = String(pb.changeCount);
  let lastTick = Date.now();
  if (!emit(snapshot(last))) return;

  const app = Application.currentApplication();
  app.includeStandardAdditions = true;

  while (true) {
    let cc = null;
    try {
      cc = String(pb.changeCount);
    } catch (e) {
      return;
    }
    if (cc !== last) {
      last = cc;
      if (!emit(snapshot(cc))) return;
      lastTick = Date.now();
    } else if (Date.now() - lastTick > 20000) {
      lastTick = Date.now();
      if (!emit({ t: 'tick', cc: cc })) return;
    }
    try {
      delay(0.35);
    } catch (e) {
      return;
    }
  }
}
