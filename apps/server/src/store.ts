import type { Artifact, AssetJob, JobStatus, LocalModelAction, LocalModelActionType, LocalModelState, ProviderId, StoredFile } from "@models/shared";
import fs from "node:fs/promises";
import path from "node:path";

interface StoreShape {
  jobs: AssetJob[];
  localModels: LocalModelState[];
  modelActions: LocalModelAction[];
}

const initialStore: StoreShape = { jobs: [], localModels: [], modelActions: [] };

export class FileStore {
  private writeChain = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly storePath = path.join(dataDir, "store.json")
  ) {}

  async init() {
    await fs.mkdir(path.join(this.dataDir, "jobs"), { recursive: true });
    try {
      await fs.access(this.storePath);
    } catch {
      await this.write(initialStore);
    }
  }

  getJobsDir() {
    return path.join(this.dataDir, "jobs");
  }

  getJobDir(jobId: string) {
    return path.join(this.getJobsDir(), jobId);
  }

  async listJobs(limit = 80) {
    const store = await this.read();
    return store.jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getJob(id: string) {
    const store = await this.read();
    return store.jobs.find((job) => job.id === id) ?? null;
  }

  async createJob(job: AssetJob) {
    await this.update((store) => {
      store.jobs.unshift(job);
      return store;
    });
    return job;
  }

  async claimNext(workerId: string) {
    const now = new Date().toISOString();
    let claimed: AssetJob | null = null;
    await this.update((store) => {
      const job = store.jobs
        .filter((candidate) => candidate.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!job) {
        return store;
      }

      job.status = "claimed";
      job.claimedBy = workerId;
      job.stage = "Claimed by GPU worker";
      job.progress = Math.max(job.progress, 5);
      job.updatedAt = now;
      claimed = structuredClone(job);
      return store;
    });
    return claimed;
  }

  async updateJob(
    id: string,
    patch:
      | Partial<AssetJob>
      | ((job: AssetJob) => void)
  ) {
    let updated: AssetJob | null = null;
    await this.update((store) => {
      const job = store.jobs.find((candidate) => candidate.id === id);
      if (!job) {
        return store;
      }

      if (typeof patch === "function") {
        patch(job);
      } else {
        Object.assign(job, patch);
      }

      job.updatedAt = new Date().toISOString();
      updated = structuredClone(job);
      return store;
    });
    return updated;
  }

  async setStatus(id: string, status: JobStatus, stage: string, progress?: number) {
    return this.updateJob(id, (job) => {
      job.status = status;
      job.stage = stage;
      if (typeof progress === "number") {
        job.progress = Math.max(0, Math.min(100, progress));
      }
      if (status === "completed") {
        job.completedAt = new Date().toISOString();
        job.progress = 100;
      }
    });
  }

  async addArtifact(id: string, artifact: Artifact) {
    return this.updateJob(id, (job) => {
      job.artifacts.push(artifact);
      job.stage = "Artifacts uploaded";
      job.progress = Math.max(job.progress, 92);
    });
  }

  async addReference(id: string, file: StoredFile) {
    return this.updateJob(id, (job) => {
      job.referenceImages.push(file);
    });
  }

  async listLocalModels() {
    const store = await this.read();
    return store.localModels;
  }

  async upsertLocalModel(model: LocalModelState) {
    await this.update((store) => {
      const existing = store.localModels.find((item) => item.providerId === model.providerId);
      if (existing) {
        Object.assign(existing, model, { updatedAt: new Date().toISOString() });
      } else {
        store.localModels.push(model);
      }
      return store;
    });
    return model;
  }

  async updateLocalModel(providerId: ProviderId, patch: Partial<LocalModelState>) {
    let updated: LocalModelState | null = null;
    await this.update((store) => {
      const model = store.localModels.find((item) => item.providerId === providerId);
      if (!model) return store;
      Object.assign(model, patch, { updatedAt: new Date().toISOString() });
      updated = structuredClone(model);
      return store;
    });
    return updated;
  }

  async createModelAction(action: LocalModelAction) {
    await this.update((store) => {
      store.modelActions.unshift(action);
      return store;
    });
    return action;
  }

  async claimNextModelAction(workerId: string) {
    const now = new Date().toISOString();
    let claimed: LocalModelAction | null = null;
    await this.update((store) => {
      const action = store.modelActions
        .filter((candidate) => candidate.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

      if (!action) return store;

      action.status = "claimed";
      action.claimedBy = workerId;
      action.stage = "Claimed by GPU worker";
      action.progress = Math.max(action.progress, 5);
      action.updatedAt = now;
      claimed = structuredClone(action);
      return store;
    });
    return claimed;
  }

  async updateModelAction(id: string, patch: Partial<LocalModelAction>) {
    let updated: LocalModelAction | null = null;
    await this.update((store) => {
      const action = store.modelActions.find((candidate) => candidate.id === id);
      if (!action) return store;
      Object.assign(action, patch, { updatedAt: new Date().toISOString() });
      if (patch.status === "completed" || patch.status === "failed") {
        action.completedAt = new Date().toISOString();
      }
      updated = structuredClone(action);
      return store;
    });
    return updated;
  }

  async enqueueModelAction(providerId: ProviderId, type: LocalModelActionType, actionId: string) {
    const now = new Date().toISOString();
    const action: LocalModelAction = {
      id: actionId,
      providerId,
      type,
      status: "queued",
      stage: "Waiting for GPU worker",
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.createModelAction(action);
    return action;
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      return {
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        localModels: Array.isArray(parsed.localModels) ? parsed.localModels : [],
        modelActions: Array.isArray(parsed.modelActions) ? parsed.modelActions : []
      };
    } catch {
      return structuredClone(initialStore);
    }
  }

  private async update(mutator: (store: StoreShape) => StoreShape) {
    this.writeChain = this.writeChain.then(async () => {
      const current = await this.read();
      await this.write(mutator(current));
    });
    await this.writeChain;
  }

  private async write(store: StoreShape) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    try {
      await fs.rename(tempPath, this.storePath);
    } catch (error) {
      if (process.platform !== "win32") {
        throw error;
      }

      await fs.copyFile(tempPath, this.storePath);
      await fs.rm(tempPath, { force: true });
    }
  }
}
