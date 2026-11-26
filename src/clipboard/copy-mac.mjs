// Puts an item back on the macOS clipboard. Invoked by src/copy.js.
// argv: [0]=mode ("text"|"image"|"files"), [1..]=paths
//
// Two macOS realities shape this file:
//
// 1. `writeObjects` with file URLs checks that this process can *reach* the
//    file. For files inside another app's container (WeChat, QQ) that check
//    fails and the pasteboard is left EMPTY, even though the call returns true.
//    Writing the same URL as a plain string has no such check, and the
//    receiving app (Finder) may well be allowed to read it. So file writes try
//    objects first and fall back to strings.
//
// 2. Pixels alone are not a file: pasting an image into Finder does nothing.
//    Image copies therefore carry the PNG/TIFF data *and* the file URL, so an
//    image pastes as an image in editors and as a file in Finder.

ObjC.import('AppKit');
ObjC.import('Foundation');

function typesOf(pb) {
  try {
    const types = pb.types;
    if (types.isNil()) return [];
    return (types.js || []).map(function (t) { return ObjC.unwrap(t); });
  } catch (e) {
    return [];
  }
}

function fileUrl(path) {
  return 'file://' + path.split('/').map(function (part) { return encodeURIComponent(part); }).join('/');
}

/** Add file flavors to the current pasteboard item without any reachability check. */
function addFileFlavors(pb, paths) {
  const list = $.NSMutableArray.array;
  for (let i = 0; i < paths.length; i++) list.addObject($(paths[i]));
  pb.setPropertyListForType(list, 'NSFilenamesPboardType');
  pb.setStringForType($(fileUrl(paths[0])), 'public.file-url');
  pb.setStringForType($(fileUrl(paths[0])), 'public.url');
  return typesOf(pb).indexOf('public.file-url') >= 0;
}

/** Canonical write first, string fallback second. */
function writeFiles(pb, paths) {
  try {
    const urls = $.NSMutableArray.array;
    for (let i = 0; i < paths.length; i++) urls.addObject($.NSURL.fileURLWithPath($(paths[i])));
    pb.writeObjects(urls);
    if (typesOf(pb).indexOf('public.file-url') >= 0) return true;
  } catch (e) { /* fall through */ }
  return addFileFlavors(pb, paths);
}

function run(argv) {
  const mode = argv[0];
  const paths = Array.prototype.slice.call(argv, 1);
  const pb = $.NSPasteboard.generalPasteboard;

  if (mode === 'text') {
    const data = $.NSData.dataWithContentsOfFile(paths[0]);
    if (data.isNil()) throw new Error('text file unreadable');
    const str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (str.isNil()) throw new Error('text is not utf8');
    pb.clearContents;
    pb.setStringForType(str, 'public.utf8-plain-text');
    if (!typesOf(pb).length) throw new Error('pasteboard stayed empty');
    return 'ok';
  }

  if (mode === 'image') {
    const path = paths[0];
    const data = $.NSData.dataWithContentsOfFile(path);
    if (data.isNil()) throw new Error('image unreadable');
    pb.clearContents;
    pb.setDataForType(data, 'public.png');
    pb.setDataForType(data, 'Apple PNG pasteboard type');
    try {
      const image = $.NSImage.alloc.initWithContentsOfFile(path);
      if (!image.isNil()) pb.setDataForType(image.TIFFRepresentation, 'public.tiff');
    } catch (e) { /* optional */ }
    addFileFlavors(pb, [path]);
    if (typesOf(pb).indexOf('public.png') < 0) throw new Error('pasteboard stayed empty');
    return 'ok';
  }

  if (mode === 'files') {
    if (!paths.length) throw new Error('no paths');
    pb.clearContents;
    if (!writeFiles(pb, paths)) throw new Error('pasteboard stayed empty');
    return 'ok';
  }

  throw new Error('unknown mode ' + mode);
}
