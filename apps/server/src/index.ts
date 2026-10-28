import cors from "@fastify/cors";
import multipart, { type MultipartFile } from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { isDownloadableProvider, providers, type Artifact, type AssetJob, type GenerationMode, type LocalModelActionType, type LocalModelState, type OutputFormat, type ProviderId, type StoredFile } from "@models/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { env } from "./env.js";
import { FileStore } from "./store.js";

const app = Fastify({ logger: true, bodyLimit: 256 * 1024 * 1024 });
const store = new FileStore(env.dataDir);
await store.init();

function asString(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value ?? fallback);
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false) {
  const text = asString(value, String(fallback)).toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function parseFormats(value: unknown): OutputFormat[] {
  const raw = asString(value, "glb,obj");
  const formats = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as OutputFormat[];
  return formats.length ? formats : ["glb", "obj"];
}

function inferFormat(name: string): Artifact["format"] {
  const extension = path.extname(name).replace(".", "").toLowerCase();
  if (["glb", "gltf", "fbx", "obj", "usdz", "blend", "zip", "png", "jpg", "mtl", "txt"].includes(extension)) {
    return extension as Artifact["format"];
  }
  return "zip";
}

function inferKind(format: Artifact["format"]): Artifact["kind"] {
  if (["png", "jpg"].includes(format)) return "preview";
  if (format === "mtl") return "material";
  if (format === "txt") return "log";
  if (format === "zip") return "archive";
  return "model";
}

function publicFileUrl(jobId: string, folder: "references" | "artifacts", filename: string) {
  return `/files/${jobId}/${folder}/${encodeURIComponent(filename)}`;
}

function defaultLocalModelState(providerId: ProviderId): LocalModelState {
  const provider = providers.find((item) => item.id === providerId);
  const now = new Date().toISOString();
  if (!provider) {
    return {
      providerId,
      status: "failed",
      stage: "Unknown provider",
      progress: 0,
      modelSizeHint: "Unknown",
      updatedAt: now
    };
  }

  if (provider.kind === "api") {
    return {
      providerId,
      status: "api",
      stage: "Hosted API, no local weights",
      progress: 100,
      modelSizeHint: provider.modelSizeHint,
      updatedAt: now
    };
  }

  if (provider.id === "mock") {
    return {
      providerId,
      status: "ready",
      stage: "Development mock is ready",
      progress: 100,
      modelSizeHint: provider.modelSizeHint,
      updatedAt: now
    };
  }

  return {
    providerId,
    status: "not_installed",
    stage: "Not installed",
    progress: 0,
    modelSizeHint: provider.modelSizeHint,
    updatedAt: now
  };
}

async function listHydratedLocalModels() {
  const stored = await store.listLocalModels();
  const byProvider = new Map(stored.map((item) => [item.providerId, item]));
  const states = providers.map((provider) => {
    const current = byProvider.get(provider.id);
    return current ? { ...defaultLocalModelState(provider.id), ...current, modelSizeHint: provider.modelSizeHint } : defaultLocalModelState(provider.id);
  });

  for (const state of states) {
    if (!byProvider.has(state.providerId)) {
      await store.upsertLocalModel(state);
    }
  }

  return states;
}

function canQueueModelAction(providerId: ProviderId, actionType: LocalModelActionType) {
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return { ok: false, error: "Provider not found" };
  if (!isDownloadableProvider(provider)) return { ok: false, error: "Hosted API providers do not need local install actions" };
  if (provider.id === "mock" && actionType === "install") return { ok: false, error: "Mock provider is already available" };
  return { ok: true };
}

async function saveMultipartFile(file: MultipartFile, targetDir: string) {
  await fs.mkdir(targetDir, { recursive: true });
  const safeName = `${nanoid(10)}-${file.filename.replace(/[^\w.\- ]+/g, "_")}`;
  const targetPath = path.join(targetDir, safeName);
  await pipeline(file.file, (await fs.open(targetPath, "w")).createWriteStream());
  const stat = await fs.stat(targetPath);
  return {
    safeName,
    path: targetPath,
    size: stat.size,
    mime: file.mimetype || "application/octet-stream"
  };
}

async function requireWorker(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization ?? "";
  if (header !== `Bearer ${env.workerSecret}`) {
    return reply.code(401).send({ error: "Worker token is invalid" });
  }
}

app.register(cors, { origin: true });
app.register(multipart, {
  limits: {
    fileSize: 256 * 1024 * 1024,
    files: 24
  }
});
app.register(fastifyStatic, {
  root: store.getJobsDir(),
  prefix: "/files/",
  decorateReply: false
});

app.get("/api/health", async () => ({
  ok: true,
  service: "models.xedoc.ru",
  now: new Date().toISOString()
}));

app.get("/api/providers", async () => providers);

app.get("/api/local-models", async () => listHydratedLocalModels());

app.post("/api/local-models/:id/:action", async (request, reply) => {
  const { id, action } = request.params as { id: ProviderId; action: LocalModelActionType };
  const actionType = action as LocalModelActionType;
  if (!["install", "test", "open_folder"].includes(actionType)) {
    return reply.code(400).send({ error: "Unknown local model action" });
  }

  await listHydratedLocalModels();
  const validation = canQueueModelAction(id, actionType);
  if (!validation.ok) return reply.code(400).send({ error: validation.error });

  const actionRecord = await store.enqueueModelAction(id, actionType, nanoid(12));
  const statusPatch: Partial<LocalModelState> =
    actionType === "install"
      ? { status: "install_queued", stage: "Install queued for GPU worker", progress: 0, error: undefined }
      : actionType === "test"
        ? { status: "testing", stage: "Test queued for GPU worker", progress: 0, error: undefined }
        : { stage: "Open folder queued for GPU worker", error: undefined };

  await store.updateLocalModel(id, statusPatch);
  return reply.code(202).send(actionRecord);
});

app.get("/api/jobs", async (request) => {
  const query = request.query as { limit?: string };
  return store.listJobs(Number(query.limit ?? 80));
});

app.get("/api/jobs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = await store.getJob(id);
  if (!job) return reply.code(404).send({ error: "Job not found" });
  return job;
});

app.post("/api/jobs", async (request, reply) => {
  if (!request.isMultipart()) {
    return reply.code(400).send({ error: "Expected multipart/form-data" });
  }

  const jobId = nanoid(12);
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = {};
  const referenceImages: StoredFile[] = [];
  const referencesDir = path.join(store.getJobDir(jobId), "references");

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "references") {
        part.file.resume();
        continue;
      }

      const saved = await saveMultipartFile(part, referencesDir);
      referenceImages.push({
        id: nanoid(10),
        name: part.filename,
        mime: saved.mime,
        size: saved.size,
        path: saved.path,
        url: publicFileUrl(jobId, "references", saved.safeName)
      });
    } else {
      fields[part.fieldname] = part.value;
    }
  }

  const prompt = asString(fields.prompt).trim();
  if (!prompt) {
    return reply.code(400).send({ error: "Prompt is required" });
  }

  const provider = (asString(fields.provider, "hunyuan3d-2.1") || "hunyuan3d-2.1") as ProviderId;
  const hasRefs = referenceImages.length > 0;
  const providerInfo = providers.find((item) => item.id === provider);
  if (!providerInfo) {
    return reply.code(400).send({ error: "Provider not found" });
  }

  if (!hasRefs && !providerInfo.modes.includes("text-to-3d")) {
    return reply.code(400).send({
      error: `${providerInfo.name} needs at least one reference image. Add a reference image before generating.`
    });
  }

  const mode = (asString(
    fields.mode,
    hasRefs ? "text-image-to-3d" : "text-to-3d"
  ) || "text-to-3d") as GenerationMode;

  const job: AssetJob = {
    id: jobId,
    prompt,
    provider,
    mode,
    status: "queued",
    quality: (asString(fields.quality, "standard") || "standard") as AssetJob["quality"],
    targetFormats: parseFormats(fields.targetFormats),
    referenceImages,
    artifacts: [],
    options: {
      pbr: asBoolean(fields.pbr, true),
      rigging: asBoolean(fields.rigging, false),
      optimizeGameReady: asBoolean(fields.optimizeGameReady, true),
      polycountTarget: Number(asString(fields.polycountTarget, "35000")) || undefined,
      style: asString(fields.style, ""),
      notes: asString(fields.notes, "")
    },
    progress: 0,
    stage: "Queued",
    createdAt: now,
    updatedAt: now
  };

  await fs.mkdir(path.join(store.getJobDir(jobId), "artifacts"), { recursive: true });
  await store.createJob(job);
  return reply.code(201).send(job);
});

app.post("/api/jobs/:id/cancel", async (request, reply) => {
  const { id } = request.params as { id: string };
  const updated = await store.setStatus(id, "cancelled", "Cancelled by user", 0);
  if (!updated) return reply.code(404).send({ error: "Job not found" });
  return updated;
});

app.get("/api/worker/jobs/next", { preHandler: requireWorker }, async (request) => {
  const query = request.query as { workerId?: string };
  const workerId = query.workerId || "gpu-worker";
  const job = await store.claimNext(workerId);
  return { job };
});

app.get("/api/worker/model-actions/next", { preHandler: requireWorker }, async (request) => {
  const query = request.query as { workerId?: string };
  const workerId = query.workerId || "gpu-worker";
  const action = await store.claimNextModelAction(workerId);
  return { action };
});

app.post("/api/worker/model-actions/:id/status", { preHandler: requireWorker }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as {
    providerId?: ProviderId;
    status?: LocalModelState["status"];
    actionStatus?: "running" | "completed" | "failed";
    stage?: string;
    progress?: number;
    localPath?: string;
    diskUsageBytes?: number;
    error?: string;
  };

  const actionPatch = Object.fromEntries(
    Object.entries({
      status: body.actionStatus,
      stage: body.stage,
      progress: body.progress,
      error: body.error
    }).filter(([, value]) => value !== undefined)
  );
  const updated = await store.updateModelAction(id, actionPatch);
  if (!updated) return reply.code(404).send({ error: "Model action not found" });

  if (body.providerId) {
    const modelPatch = Object.fromEntries(
      Object.entries({
        status: body.status,
        stage: body.stage,
        progress: body.progress,
        localPath: body.localPath,
        diskUsageBytes: body.diskUsageBytes,
        error: body.error
      }).filter(([, value]) => value !== undefined)
    );
    await store.updateLocalModel(body.providerId, modelPatch);
  }

  return updated;
});

app.post("/api/worker/jobs/:id/status", { preHandler: requireWorker }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Partial<Pick<AssetJob, "status" | "stage" | "progress">>;
  const updated = await store.updateJob(id, (job) => {
    if (body.status) job.status = body.status;
    if (body.stage) job.stage = body.stage;
    if (typeof body.progress === "number") job.progress = Math.max(0, Math.min(100, body.progress));
  });
  if (!updated) return reply.code(404).send({ error: "Job not found" });
  return updated;
});

app.post("/api/worker/jobs/:id/error", { preHandler: requireWorker }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { error?: string };
  const updated = await store.updateJob(id, (job) => {
    job.status = "failed";
    job.error = body.error || "Worker failed without details";
    job.stage = "Failed";
    job.progress = Math.max(job.progress, 1);
  });
  if (!updated) return reply.code(404).send({ error: "Job not found" });
  return updated;
});

app.post("/api/worker/jobs/:id/artifacts", { preHandler: requireWorker }, async (request, reply) => {
  const { id } = request.params as { id: string };
  if (!request.isMultipart()) {
    return reply.code(400).send({ error: "Expected multipart/form-data" });
  }

  const job = await store.getJob(id);
  if (!job) return reply.code(404).send({ error: "Job not found" });

  await store.setStatus(id, "uploading", "Uploading artifacts", 88);
  const artifactsDir = path.join(store.getJobDir(id), "artifacts");
  const uploaded: Artifact[] = [];

  for await (const part of request.parts()) {
    if (part.type !== "file") continue;
    const saved = await saveMultipartFile(part, artifactsDir);
    const format = inferFormat(part.filename);
    const artifact: Artifact = {
      id: nanoid(10),
      kind: inferKind(format),
      name: part.filename,
      mime: saved.mime,
      size: saved.size,
      format,
      url: publicFileUrl(id, "artifacts", saved.safeName),
      createdAt: new Date().toISOString()
    };
    uploaded.push(artifact);
    await store.addArtifact(id, artifact);
  }

  await store.setStatus(id, "completed", "Completed", 100);
  return { artifacts: uploaded };
});

await app.listen({ port: env.port, host: env.host });
