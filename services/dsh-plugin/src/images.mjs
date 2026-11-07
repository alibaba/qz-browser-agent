import { lstat, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { tmpdir } from "node:os";
import { HarnessError } from "@deepseek-ai/dsh-llm";

/** Import only files materialized by this CLI call; screenshots are always script-requested. */
export async function captureImages(attachments, stderr, signal) {
  const paths = [...new Set(stderr.split("\n").flatMap(line => line.startsWith("Image: ") ? [line.slice(7).trim()] : []))];
  if (!paths.length) return [];
  const owned = [];
  try {
    const temporaryRoot = await realpath(tmpdir());
    for (const path of paths) {
      const directory = dirname(path);
      if (!/^qz-script-[\w-]+$/.test(basename(directory)) || !/^\d+\.(png|jpg|webp)$/.test(basename(path))
        || await realpath(dirname(directory)) !== temporaryRoot || !(await lstat(directory)).isDirectory()
        || !(await lstat(path)).isFile()) {
        throw new HarnessError("qz returned an unexpected screenshot path.", "QZ_INVALID_IMAGE");
      }
      owned.push(path);
    }
    if (!attachments) throw new HarnessError("No image attachment store is available for the browser screenshot.", "QZ_IMAGES_UNAVAILABLE");
    const inputs = [];
    let bytes = 0;
    for (const path of owned) {
      signal.throwIfAborted();
      const info = await lstat(path);
      bytes += info.size;
      if (info.size > attachments.imageLimits.maxImageBytes || bytes > attachments.imageLimits.maxMessageImageBytes) {
        throw new HarnessError("The browser screenshots exceed the attachment size limit.", "QZ_IMAGE_TOO_LARGE");
      }
      inputs.push({ data: await readFile(path), name: basename(path),
        mediaType: extname(path) === ".jpg" ? "image/jpeg" : extname(path) === ".webp" ? "image/webp" : "image/png" });
    }
    signal.throwIfAborted();
    return await attachments.saveImages(inputs);
  } finally {
    await Promise.all(owned.map(path => unlink(path).catch(() => {})));
    await Promise.all([...new Set(owned.map(dirname))].map(path => rmdir(path).catch(() => {})));
  }
}
