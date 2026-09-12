// Install the declared dependency from vendor/ into node_modules.
//
// Idempotent: a reconstruction that runs twice changes nothing. The
// fixture stays offline; the dependency is vendored content.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "node_modules", "acme-format");
mkdirSync(join(root, "node_modules"), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(join(root, "vendor", "acme-format"), target, { recursive: true });
console.log(`installed acme-format at node_modules/acme-format`);
