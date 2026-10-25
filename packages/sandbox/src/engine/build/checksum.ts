// Flyway's checksum of a migration, as it writes it in flyway_schema_history:
// CRC32 updated line by line, each line without its line break (as Java's
// BufferedReader.readLine splits them: \r\n, \r or \n), a byte order mark
// removed from the first line, read as a signed 32-bit integer. The schema
// check compares it with the number Flyway itself wrote (tools/check.ts).
import { crc32 } from "node:zlib";

export function flywayChecksum(text: string): number {
  const lines = text.split(/\r\n|\r|\n/);
  let crc = 0;
  lines.forEach((line, index) => {
    const content = index === 0 && line.startsWith("﻿") ? line.slice(1) : line;
    crc = crc32(Buffer.from(content, "utf8"), crc);
  });
  return crc | 0;
}
