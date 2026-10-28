import "dotenv/config";
import path from "node:path";

export const env = {
  port: Number(process.env.PORT ?? 3421),
  host: process.env.HOST ?? "0.0.0.0",
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3421}`,
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "../../data")),
  workerSecret: process.env.WORKER_SECRET ?? "change-me"
};
