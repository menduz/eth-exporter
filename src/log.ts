import { format } from "util"

export function log(fmt: string, ...args: string[]) {
  process.stderr.write(format(fmt, ...args) + "\n")
}
