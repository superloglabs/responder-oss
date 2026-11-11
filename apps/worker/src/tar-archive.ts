// Builds an uncompressed POSIX tar archive in memory, so many small files
// reach a sandbox in one write and one `tar -x` instead of a provider round
// trip each. A path longer than the ustar name field is carried in a PAX
// header, which GNU and BSD tar both read.

export type TarFile = {
  content: string | Uint8Array;
  path: string;
};

const blockSize = 512;
const nameFieldBytes = 100;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: Buffer, size: number, type: "0" | "x", mtime: number): Buffer {
  const block = Buffer.alloc(blockSize);
  name.copy(block, 0, 0, Math.min(name.length, nameFieldBytes));
  block.write(octal(0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(mtime, 12), 136, "ascii");
  block.write(" ".repeat(8), 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function padding(size: number): Buffer {
  return Buffer.alloc((blockSize - (size % blockSize)) % blockSize);
}

// A PAX record is "<length> <key>=<value>\n", where the length counts its own
// digits.
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body);
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) {
    length = String(length).length + bodyBytes;
  }
  return Buffer.from(`${length}${body}`);
}

export function createTarArchive(
  files: TarFile[],
  mtime: number = Math.floor(Date.now() / 1000),
): Uint8Array {
  const parts: Buffer[] = [];
  for (const file of files) {
    const name = Buffer.from(file.path);
    const content = typeof file.content === "string"
      ? Buffer.from(file.content)
      : Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength);
    if (name.length > nameFieldBytes) {
      const record = paxRecord("path", file.path);
      parts.push(
        header(Buffer.from("PaxHeader"), record.length, "x", mtime),
        record,
        padding(record.length),
      );
    }
    parts.push(header(name, content.length, "0", mtime), content, padding(content.length));
  }
  parts.push(Buffer.alloc(blockSize * 2));
  return new Uint8Array(Buffer.concat(parts));
}
