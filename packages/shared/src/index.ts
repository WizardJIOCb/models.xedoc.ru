export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "uploading"
  | "completed"
  | "failed"
  | "cancelled";

export type GenerationMode =
  | "text-to-3d"
  | "image-to-3d"
  | "text-image-to-3d"
  | "rigging";

export type ProviderKind = "local" | "api" | "postprocess";

export type ProviderId =
  | "hunyuan3d-2.1"
  | "trellis-2"
  | "stable-fast-3d"
  | "triposr"
  | "meshy"
  | "tripo"
  | "rodin"
  | "unirig"
  | "make-it-animatable"
  | "riganything"
  | "mock";

export type OutputFormat = "glb" | "gltf" | "fbx" | "obj" | "usdz" | "blend" | "zip";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  modes: GenerationMode[];
  description: string;
  strengths: string[];
  outputs: OutputFormat[];
  recommendedVramGb?: number;
  modelSizeHint: string;
  setupHint: string;
}

export type LocalModelStatus =
  | "not_installed"
  | "install_queued"
  | "installing"
  | "installed"
  | "testing"
  | "ready"
  | "failed"
  | "api";

export type LocalModelActionType = "install" | "test" | "open_folder";

export interface LocalModelState {
  providerId: ProviderId;
  status: LocalModelStatus;
  stage: string;
  progress: number;
  modelSizeHint: string;
  diskUsageBytes?: number;
  localPath?: string;
  error?: string;
  updatedAt: string;
}

export interface LocalModelAction {
  id: string;
  providerId: ProviderId;
  type: LocalModelActionType;
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  stage: string;
  progress: number;
  error?: string;
  claimedBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  url: string;
}

export interface Artifact {
  id: string;
  kind: "model" | "material" | "preview" | "log" | "archive";
  name: string;
  mime: string;
  size: number;
  format: OutputFormat | "txt" | "png" | "jpg" | "mtl";
  url: string;
  createdAt: string;
}

export interface JobOptions {
  pbr: boolean;
  rigging: boolean;
  optimizeGameReady: boolean;
  polycountTarget?: number;
  style?: string;
  notes?: string;
}

export interface AssetJob {
  id: string;
  prompt: string;
  provider: ProviderId;
  mode: GenerationMode;
  status: JobStatus;
  quality: "draft" | "standard" | "production";
  targetFormats: OutputFormat[];
  referenceImages: StoredFile[];
  artifacts: Artifact[];
  options: JobOptions;
  progress: number;
  stage: string;
  error?: string;
  claimedBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkerJobPayload extends AssetJob {
  referenceImages: StoredFile[];
}

export function isDownloadableProvider(provider: ProviderInfo) {
  return provider.kind === "local" || provider.kind === "postprocess";
}

export const providers: ProviderInfo[] = [
  {
    id: "hunyuan3d-2.1",
    name: "Hunyuan3D 2.1",
    kind: "local",
    modes: ["image-to-3d", "text-image-to-3d"],
    description: "Open-source image-to-3D pipeline with high fidelity geometry and PBR material generation.",
    strengths: ["PBR materials", "strong image conditioning", "good production baseline"],
    outputs: ["glb", "obj", "gltf"],
    recommendedVramGb: 16,
    modelSizeHint: "~20-30 GB local weights/cache",
    setupHint: "Configure a local runner command for Tencent-Hunyuan/Hunyuan3D-2.1."
  },
  {
    id: "trellis-2",
    name: "TRELLIS.2",
    kind: "local",
    modes: ["image-to-3d"],
    description: "Open-source high-fidelity image-to-3D model focused on complex topology and PBR assets.",
    strengths: ["sharp topology", "PBR output", "strong asset quality"],
    outputs: ["glb", "obj", "gltf"],
    recommendedVramGb: 16,
    modelSizeHint: "~8-16 GB local weights",
    setupHint: "Configure a Microsoft TRELLIS.2 runner command when the model environment is installed."
  },
  {
    id: "stable-fast-3d",
    name: "Stable Fast 3D",
    kind: "local",
    modes: ["image-to-3d"],
    description: "Fast single-image reconstruction with UV unwrapping and material parameters.",
    strengths: ["very fast", "single image", "UV and materials"],
    outputs: ["glb", "obj"],
    recommendedVramGb: 8,
    modelSizeHint: "~2-4 GB local weights",
    setupHint: "Configure a Stability-AI/stable-fast-3d runner for quick drafts."
  },
  {
    id: "triposr",
    name: "TripoSR",
    kind: "local",
    modes: ["image-to-3d"],
    description: "Fast open-source single-image reconstruction, useful for previews and rough shape capture.",
    strengths: ["fast drafts", "low friction", "consumer GPU friendly"],
    outputs: ["obj", "glb"],
    recommendedVramGb: 8,
    modelSizeHint: "~1-2 GB local weights",
    setupHint: "Configure VAST-AI-Research/TripoSR as a local command runner."
  },
  {
    id: "meshy",
    name: "Meshy API",
    kind: "api",
    modes: ["text-to-3d", "image-to-3d", "text-image-to-3d"],
    description: "Hosted text/image to 3D workflow with preview/refine style generation.",
    strengths: ["hosted", "text-to-3D", "format conversion"],
    outputs: ["glb", "fbx", "obj", "usdz"],
    modelSizeHint: "0 GB local, hosted API",
    setupHint: "Set MESHY_API_KEY and add an API adapter."
  },
  {
    id: "tripo",
    name: "Tripo API",
    kind: "api",
    modes: ["text-to-3d", "image-to-3d", "text-image-to-3d"],
    description: "Hosted text, image, and multi-view to 3D generation with post-processing options.",
    strengths: ["multi-view", "low-poly options", "animation/post-processing"],
    outputs: ["glb", "fbx", "obj", "usdz"],
    modelSizeHint: "0 GB local, hosted API",
    setupHint: "Set TRIPO_API_KEY and add an API adapter."
  },
  {
    id: "rodin",
    name: "Hyper3D Rodin API",
    kind: "api",
    modes: ["text-to-3d", "image-to-3d", "text-image-to-3d"],
    description: "Hosted professional 3D asset generation from text or images.",
    strengths: ["production assets", "multi-image", "hosted rendering"],
    outputs: ["glb", "fbx", "obj", "usdz"],
    modelSizeHint: "0 GB local, hosted API",
    setupHint: "Set RODIN_API_KEY and add an API adapter."
  },
  {
    id: "unirig",
    name: "UniRig",
    kind: "postprocess",
    modes: ["rigging"],
    description: "Automatic skeleton and skinning for diverse 3D meshes.",
    strengths: ["diverse assets", "skeleton prediction", "skinning"],
    outputs: ["glb", "fbx"],
    recommendedVramGb: 8,
    modelSizeHint: "~3-6 GB local weights",
    setupHint: "Use after mesh generation as a post-process runner."
  },
  {
    id: "make-it-animatable",
    name: "Make-It-Animatable",
    kind: "postprocess",
    modes: ["rigging"],
    description: "Fast animation-ready rigging for humanoid characters.",
    strengths: ["humanoids", "rest pose", "animation-ready"],
    outputs: ["glb", "fbx"],
    recommendedVramGb: 8,
    modelSizeHint: "~1-3 GB local weights",
    setupHint: "Best for anime/humanoid character outputs."
  },
  {
    id: "riganything",
    name: "RigAnything",
    kind: "postprocess",
    modes: ["rigging"],
    description: "Template-free auto-rigging for diverse assets.",
    strengths: ["template-free", "skeleton topology", "skinning"],
    outputs: ["glb", "fbx"],
    recommendedVramGb: 8,
    modelSizeHint: "~2-5 GB local weights",
    setupHint: "Use as a post-process runner for non-humanoid meshes."
  },
  {
    id: "mock",
    name: "Mock OBJ generator",
    kind: "local",
    modes: ["text-to-3d", "image-to-3d", "text-image-to-3d"],
    description: "Development runner that returns a simple OBJ/MTL asset without GPU work.",
    strengths: ["dev smoke tests", "no GPU required", "checks upload/export flow"],
    outputs: ["obj", "zip"],
    modelSizeHint: "<1 MB, no model weights",
    setupHint: "Default development provider."
  }
];
