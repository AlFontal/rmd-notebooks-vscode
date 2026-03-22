import { createHash } from "node:crypto";

export function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
