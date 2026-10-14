import { spawn } from "node:child_process";
import path from "node:path";

const port = process.env.DATABRICKS_APP_PORT || process.env.PORT || "8000";
const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextBin, "start", "-H", "0.0.0.0", "-p", port], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
