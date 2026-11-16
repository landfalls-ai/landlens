// The import's file read (wave 10 part 4, D217; security review of part 4, M1). Main reads the file the person chose in
// its own open dialog, and only a regular file: a symbolic link, a named pipe, a device or a directory is refused
// without being read (a link to /dev/zero, or a pipe, would otherwise block main's thread and grow without bound). The
// file is opened without following a link and without waiting on a pipe, checked again on the open descriptor, and read
// at most to one byte past the limit into a buffer of that size: its own size is never allocated, and a file that grew
// past the limit since it was checked is refused too.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { FILE_NOTES, VIEW_LIMITS } from "@landlens/views";

export const READ_NOTES = {
  notFile: "This isn't a regular file (a link, a pipe, a device or a folder): Landlens imports a view only from a file.",
  unreadable: "Landlens couldn't read this file.",
} as const;

/** The chosen file's bytes, at most `max`, or why it wasn't read. Never blocks on a pipe or reads past `max + 1`. */
export async function readImport(path: string, max: number = VIEW_LIMITS.importBytes): Promise<Uint8Array | { refused: string }> {
  try {
    if (!(await lstat(path)).isFile()) return { refused: READ_NOTES.notFile };
  } catch {
    return { refused: READ_NOTES.unreadable };
  }
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // No link followed (the path may have changed since lstat), and no wait for a pipe's writer.
    fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return { refused: (e as { code?: string }).code === "ELOOP" ? READ_NOTES.notFile : READ_NOTES.unreadable };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { refused: READ_NOTES.notFile };
    if (st.size > max) return { refused: FILE_NOTES.tooBig(st.size) };
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    if (got > max) return { refused: FILE_NOTES.tooBig(got) };
    return new Uint8Array(buf.subarray(0, got));
  } catch {
    return { refused: READ_NOTES.unreadable };
  } finally {
    await fh.close().catch(() => undefined);
  }
}
