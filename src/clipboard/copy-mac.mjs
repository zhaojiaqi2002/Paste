// Puts an item back on the macOS clipboard. Invoked by src/copy.js.
// argv: [0]=mode ("text"|"image"|"files"), [1..]=paths
// Prints "ok" on success; throws (non-zero exit) otherwise.

ObjC.import('AppKit');
ObjC.import('Foundation');

function run(argv) {
  const mode = argv[0];
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;

  if (mode === 'text') {
    const data = $.NSData.dataWithContentsOfFile(argv[1]);
    if (data.isNil()) throw new Error('text file unreadable');
    const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (str.isNil()) throw new Error('text is not utf8');
    pb.setStringForType(str, 'public.utf8-plain-text');
    return assertWritten(pb);
  }

  if (mode === 'image') {
    const data = $.NSData.dataWithContentsOfFile(argv[1]);
    if (data.isNil()) throw new Error('image unreadable');
    pb.setDataForType(data, 'public.png');
    pb.setDataForType(data, 'Apple PNG pasteboard type');
    // Some apps only accept TIFF; derive it from the PNG for maximum compatibility.
    try {
      const image = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
      if (!image.isNil()) {
        pb.setDataForType(image.TIFFRepresentation, 'public.tiff');
      }
    } catch (e) { /* optional */ }
    return assertWritten(pb);
  }

  if (mode === 'files') {
    const urls = $.NSMutableArray.array;
    for (let i = 1; i < argv.length; i++) {
      urls.addObject($.NSURL.fileURLWithPath($(argv[i])));
    }
    if (!urls.count) throw new Error('no paths');
    if (!pb.writeObjects(urls)) throw new Error('pasteboard rejected files');
    return assertWritten(pb);
  }

  throw new Error('unknown mode ' + mode);
}

// A file URL for a file nobody can read (chmod 000) is accepted by writeObjects
// but leaves the pasteboard empty. Report failure instead of a false success.
function assertWritten(pb) {
  const types = pb.types;
  if (types.isNil() || types.count === 0) throw new Error('pasteboard stayed empty');
  return 'ok';
}
