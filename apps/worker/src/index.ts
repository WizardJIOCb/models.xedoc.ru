import type { AssetJob, LocalModelAction, LocalModelState, ProviderId, WorkerJobPayload } from "@models/shared";
import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "apps/worker/.env"), override: true });

interface RunnerCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const env = {
  serverUrl: (process.env.SERVER_URL ?? "http://localhost:3421").replace(/\/$/, ""),
  workerSecret: process.env.WORKER_SECRET ?? "change-me",
  workerId: process.env.WORKER_ID ?? os.hostname(),
  pollMs: Number(process.env.POLL_INTERVAL_MS ?? 2500),
  runnerMode: process.env.RUNNER_MODE ?? "mock",
  mockWhenUnconfigured: (process.env.MOCK_WHEN_UNCONFIGURED ?? "true").toLowerCase() === "true",
  commands: parseRunnerCommands(process.env.RUNNER_COMMANDS_JSON ?? "{}"),
  modelActionCommands: parseRunnerCommands(process.env.MODEL_ACTION_COMMANDS_JSON ?? "{}"),
  modelBaseDir: path.resolve(process.env.MODEL_BASE_DIR ?? path.join(os.homedir(), "models.xedoc.ru", "local-models"))
};

const postprocessProviders = new Set<ProviderId>(["unirig", "make-it-animatable", "riganything"]);

function parseRunnerCommands(raw: string): Record<string, RunnerCommand> {
  try {
    const parsed = JSON.parse(raw) as Record<string, RunnerCommand>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type ApiInit = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${env.workerSecret}` };
}

async function api<T>(pathName: string, init?: ApiInit): Promise<T> {
  const response = await fetch(`${env.serverUrl}${pathName}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function updateStatus(job: AssetJob, status: AssetJob["status"], stage: string, progress: number) {
  await api(`/api/worker/jobs/${job.id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, stage, progress })
  });
}

async function failJob(job: AssetJob, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await api(`/api/worker/jobs/${job.id}/error`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: message })
  });
}

async function updateModelAction(
  action: LocalModelAction,
  actionStatus: LocalModelAction["status"],
  status: LocalModelState["status"],
  stage: string,
  progress: number,
  extras: Partial<Pick<LocalModelState, "localPath" | "diskUsageBytes" | "error">> = {}
) {
  await api(`/api/worker/model-actions/${action.id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: action.providerId,
      actionStatus,
      status,
      stage,
      progress,
      ...extras
    })
  });
}

async function uploadArtifacts(job: AssetJob, outputDir: string) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  if (!files.length) {
    throw new Error(`Runner completed but produced no files in ${outputDir}`);
  }

  const form = new FormData();
  for (const file of files) {
    const filePath = path.join(outputDir, file.name);
    const buffer = await fs.readFile(filePath);
    form.append("artifacts", new Blob([new Uint8Array(buffer)], { type: mimeFor(file.name) }), file.name);
  }

  await fetch(`${env.serverUrl}/api/worker/jobs/${job.id}/artifacts`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  }).then(async (response) => {
    if (!response.ok) throw new Error(await response.text());
  });
}

function mimeFor(name: string) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".obj") return "model/obj";
  if (ext === ".glb") return "model/gltf-binary";
  if (ext === ".gltf") return "model/gltf+json";
  if (ext === ".fbx") return "application/octet-stream";
  if (ext === ".mtl") return "text/plain";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

async function runJob(job: WorkerJobPayload) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `models-${job.id}-`));
  const inputDir = path.join(workDir, "input");
  const outputDir = path.join(workDir, "output");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  await updateStatus(job, "running", "Preparing references", 12);
  const localRefs = await downloadReferences(job, inputDir);
  const runnerPayload = {
    ...job,
    localReferences: localRefs,
    outputDir
  };
  const jobFile = path.join(workDir, "job.json");
  await fs.writeFile(jobFile, JSON.stringify(runnerPayload, null, 2), "utf8");

  await updateStatus(job, "running", "Generating 3D asset", 25);
  const command = env.commands[job.provider];
  if (command) {
    await runCommand(command, jobFile, outputDir);
  } else if (postprocessProviders.has(job.provider)) {
    throw new Error(`${job.provider} is a rigging/postprocess provider. Generate a mesh with a text/image-to-3D provider first, then run this provider on the mesh.`);
  } else if (env.runnerMode === "mock" || env.mockWhenUnconfigured) {
    await runMockGenerator(job, outputDir);
  } else {
    throw new Error(`No runner command configured for provider "${job.provider}"`);
  }

  await updateStatus(job, "running", "Uploading generated files", 84);
  await uploadArtifacts(job, outputDir);
}

async function downloadReferences(job: WorkerJobPayload, inputDir: string) {
  const downloaded: string[] = [];
  for (const ref of job.referenceImages) {
    const response = await fetch(`${env.serverUrl}${ref.url}`);
    if (!response.ok) throw new Error(`Cannot download reference ${ref.name}: ${response.statusText}`);
    const arrayBuffer = await response.arrayBuffer();
    const filePath = path.join(inputDir, ref.name.replace(/[^\w.\- ]+/g, "_"));
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    downloaded.push(filePath);
  }
  return downloaded;
}

async function runCommand(command: RunnerCommand, jobFile: string, outputDir: string) {
  const args = (command.args ?? []).map((arg) =>
    arg.replaceAll("{jobFile}", jobFile).replaceAll("{outputDir}", outputDir)
  );

  await new Promise<void>((resolve, reject) => {
    let output = "";
    const child = spawn(command.command, args, {
      cwd: command.cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(command.env ?? {}),
        JOB_FILE: jobFile,
        OUTPUT_DIR: outputDir
      }
    });
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const tail = output.trim().split(/\r?\n/).slice(-8).join("\n");
        reject(new Error(`Runner exited with code ${code}${tail ? `:\n${tail}` : ""}`));
      }
    });
    child.on("error", reject);
  });
}

async function runModelAction(action: LocalModelAction) {
  const modelDir = modelDirectory(action.providerId);
  const commandKey = `${action.providerId}:${action.type}`;
  const command = env.modelActionCommands[commandKey];

  if (action.type === "open_folder") {
    await updateModelAction(action, "running", "installed", "Opening model folder", 50, { localPath: modelDir });
    await openFolder(modelDir);
    const usage = await diskUsage(modelDir);
    await updateModelAction(action, "completed", "installed", "Model folder opened", 100, {
      localPath: modelDir,
      diskUsageBytes: usage
    });
    return;
  }

  if (!command) {
    const exists = await pathExists(modelDir);
    if (action.type === "test" && exists) {
      const usage = await diskUsage(modelDir);
      await updateModelAction(action, "completed", "ready", "Folder exists. Add a test command for deeper validation.", 100, {
        localPath: modelDir,
        diskUsageBytes: usage
      });
      return;
    }

    await updateModelAction(
      action,
      "failed",
      "failed",
      `No ${action.type} command configured for ${action.providerId}`,
      0,
      {
        localPath: modelDir,
        error: `Set MODEL_ACTION_COMMANDS_JSON key "${commandKey}" on the worker.`
      }
    );
    return;
  }

  await fs.mkdir(modelDir, { recursive: true });
  await updateModelAction(
    action,
    "running",
    action.type === "install" ? "installing" : "testing",
    action.type === "install" ? "Installing model weights" : "Testing local model",
    15,
    { localPath: modelDir }
  );
  await runModelCommand(command, action.providerId, modelDir);
  const usage = await diskUsage(modelDir);
  await updateModelAction(action, "completed", "ready", "Ready", 100, {
    localPath: modelDir,
    diskUsageBytes: usage
  });
}

async function runModelCommand(command: RunnerCommand, providerId: ProviderId, modelDir: string) {
  const args = (command.args ?? []).map((arg) =>
    arg
      .replaceAll("{providerId}", providerId)
      .replaceAll("{modelDir}", modelDir)
  );

  await new Promise<void>((resolve, reject) => {
    let output = "";
    const child = spawn(command.command, args, {
      cwd: command.cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(command.env ?? {}),
        PROVIDER_ID: providerId,
        MODEL_DIR: modelDir
      }
    });
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const tail = output.trim().split(/\r?\n/).slice(-40).join("\n");
        reject(new Error(`Model action command exited with code ${code}${tail ? `:\n${tail}` : ""}`));
      }
    });
    child.on("error", reject);
  });
}

function modelDirectory(providerId: ProviderId) {
  return path.join(env.modelBaseDir, providerId.replace(/[^\w.\-]+/g, "_"));
}

async function openFolder(folderPath: string) {
  if (!(await pathExists(folderPath))) {
    throw new Error(`Model folder does not exist: ${folderPath}`);
  }

  const command =
    process.platform === "win32"
      ? { command: "explorer.exe", args: [folderPath] }
      : process.platform === "darwin"
        ? { command: "open", args: [folderPath] }
        : { command: "xdg-open", args: [folderPath] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function diskUsage(targetPath: string): Promise<number> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const sizes = await Promise.all(entries.map((entry) => diskUsage(path.join(targetPath, entry.name))));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch {
    return 0;
  }
}

async function runMockGenerator(job: AssetJob, outputDir: string) {
  const seed = hash(job.prompt + job.id);
  const height = 1.4 + (seed % 9) / 10;
  const width = 0.9 + (seed % 5) / 10;
  const depth = 0.8 + (seed % 7) / 10;
  const color = `Kd ${((seed >> 4) & 255) / 255} ${((seed >> 12) & 255) / 255} ${((seed >> 20) & 255) / 255}`;
  const obj = [
    "mtllib material.mtl",
    "o generated_asset_mock",
    `# prompt: ${job.prompt.replace(/\r?\n/g, " ")}`,
    `v ${-width} 0 ${-depth}`,
    `v ${width} 0 ${-depth}`,
    `v ${width} 0 ${depth}`,
    `v ${-width} 0 ${depth}`,
    `v ${-width * 0.72} ${height} ${-depth * 0.72}`,
    `v ${width * 0.72} ${height} ${-depth * 0.72}`,
    `v ${width * 0.72} ${height} ${depth * 0.72}`,
    `v ${-width * 0.72} ${height} ${depth * 0.72}`,
    "usemtl generated_mat",
    "f 1 2 3 4",
    "f 5 8 7 6",
    "f 1 5 6 2",
    "f 2 6 7 3",
    "f 3 7 8 4",
    "f 4 8 5 1"
  ].join("\n");

  const mtl = ["newmtl generated_mat", color, "Ka 0.04 0.04 0.04", "Ks 0.25 0.25 0.25", "Ns 32"].join("\n");
  const readme = [
    "Mock generation output",
    `Provider: ${job.provider}`,
    `Mode: ${job.mode}`,
    `Quality: ${job.quality}`,
    `Target formats: ${job.targetFormats.join(", ")}`,
    "",
    "Replace RUNNER_MODE=mock with a provider command to run real AI generation."
  ].join("\n");

  await fs.writeFile(path.join(outputDir, "generated-model.obj"), obj, "utf8");
  await fs.writeFile(path.join(outputDir, "material.mtl"), mtl, "utf8");
  await fs.writeFile(path.join(outputDir, "generation-notes.txt"), readme, "utf8");
}

function hash(input: string) {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

async function loop() {
  console.log(`[worker] ${env.workerId} polling ${env.serverUrl}`);
  while (true) {
    try {
      const { action } = await api<{ action: LocalModelAction | null }>(
        `/api/worker/model-actions/next?workerId=${encodeURIComponent(env.workerId)}`
      );

      if (action) {
        console.log(`[worker] claimed model action ${action.id} (${action.providerId}:${action.type})`);
        try {
          await runModelAction(action);
          console.log(`[worker] completed model action ${action.id}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[worker] failed model action ${action.id}`, error);
          await updateModelAction(action, "failed", "failed", "Model action failed", 0, { error: message });
        }
        await new Promise((resolve) => setTimeout(resolve, env.pollMs));
        continue;
      }

      const { job } = await api<{ job: WorkerJobPayload | null }>(
        `/api/worker/jobs/next?workerId=${encodeURIComponent(env.workerId)}`
      );

      if (job) {
        console.log(`[worker] claimed ${job.id} (${job.provider})`);
        try {
          await runJob(job);
          console.log(`[worker] completed ${job.id}`);
        } catch (error) {
          console.error(`[worker] failed ${job.id}`, error);
          await failJob(job, error);
        }
      }
    } catch (error) {
      console.error("[worker] poll error", error);
    }

    await new Promise((resolve) => setTimeout(resolve, env.pollMs));
  }
}

await loop();
