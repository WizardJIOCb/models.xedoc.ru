import type { Artifact, AssetJob, LocalModelActionType, LocalModelState, OutputFormat, ProviderId, ProviderInfo } from "@models/shared";
import { Box, CheckCircle2, Download, FolderOpen, HardDrive, ImagePlus, Loader2, PauseCircle, Play, RefreshCw, Send, Settings2, Sparkles, UploadCloud } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const formats: OutputFormat[] = ["glb", "obj", "fbx", "usdz", "blend"];

export function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelState[]>([]);
  const [jobs, setJobs] = useState<AssetJob[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [prompt, setPrompt] = useState("stylized anime game prop, clean topology, PBR materials, game-ready low poly");
  const [provider, setProvider] = useState<ProviderId>("hunyuan3d-2.1");
  const [quality, setQuality] = useState<AssetJob["quality"]>("standard");
  const [targetFormats, setTargetFormats] = useState<OutputFormat[]>(["glb", "obj"]);
  const [refs, setRefs] = useState<File[]>([]);
  const [rigging, setRigging] = useState(false);
  const [pbr, setPbr] = useState(true);
  const [optimize, setOptimize] = useState(true);
  const [polycount, setPolycount] = useState(35000);
  const [submitting, setSubmitting] = useState(false);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? jobs[0],
    [jobs, selectedId]
  );
  const selectedProvider = providers.find((item) => item.id === provider);
  const canGenerateWithProvider = selectedProvider?.kind !== "postprocess";
  const needsReference = Boolean(selectedProvider && !selectedProvider.modes.includes("text-to-3d"));
  const canSubmit = Boolean(canGenerateWithProvider && (!needsReference || refs.length > 0));

  async function load() {
    const [providerResponse, jobResponse] = await Promise.all([
      fetch(`${API_BASE}/api/providers`),
      fetch(`${API_BASE}/api/jobs`)
    ]);
    const [loadedProviders, localModelResponse] = await Promise.all([
      providerResponse.json() as Promise<ProviderInfo[]>,
      fetch(`${API_BASE}/api/local-models`)
    ]);
    setProviders(loadedProviders);
    setLocalModels(await localModelResponse.json());
    const loadedJobs = (await jobResponse.json()) as AssetJob[];
    setJobs(loadedJobs);
    if (!selectedId && loadedJobs[0]) setSelectedId(loadedJobs[0].id);
  }

  async function queueModelAction(providerId: ProviderId, action: LocalModelActionType) {
    const response = await fetch(`${API_BASE}/api/local-models/${providerId}/${action}`, { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    await load();
  }

  useEffect(() => {
    load().catch(console.error);
    const timer = window.setInterval(() => load().catch(console.error), 3000);
    return () => window.clearInterval(timer);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("prompt", prompt);
      form.set("provider", provider);
      form.set("quality", quality);
      form.set("targetFormats", targetFormats.join(","));
      form.set("pbr", String(pbr));
      form.set("rigging", String(rigging));
      form.set("optimizeGameReady", String(optimize));
      form.set("polycountTarget", String(polycount));
      for (const file of refs) form.append("references", file);

      const response = await fetch(`${API_BASE}/api/jobs`, { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const created = (await response.json()) as AssetJob;
      setSelectedId(created.id);
      setRefs([]);
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  function toggleFormat(format: OutputFormat) {
    setTargetFormats((current) =>
      current.includes(format)
        ? current.filter((item) => item !== format)
        : [...current, format]
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Box size={21} /></div>
          <div>
            <strong>models.xedoc.ru</strong>
            <span>3D generation cockpit</span>
          </div>
        </div>
        <button className="icon-button" onClick={() => load().catch(console.error)} title="Refresh queue">
          <RefreshCw size={18} />
        </button>
      </header>

      <section className="workspace">
        <form className="panel composer" onSubmit={submit}>
          <div className="panel-title">
            <Sparkles size={18} />
            <h1>Новая 3D модель</h1>
          </div>

          <label className="field">
            <span>Промпт</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} />
          </label>

          <label className="field">
            <span>Провайдер</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>{item.name} - {item.modelSizeHint}</option>
              ))}
            </select>
          </label>

          {selectedProvider && (
            <div className="provider-note">
              <div className="provider-meta">
                <strong>{selectedProvider.kind}</strong>
                <span>{selectedProvider.modelSizeHint}</span>
              </div>
              <span>{selectedProvider.description}</span>
              {!canGenerateWithProvider ? (
                <span>This provider needs an existing 3D mesh and runs after generation.</span>
              ) : null}
              {canGenerateWithProvider && needsReference ? (
                <span>Requires at least one reference image.</span>
              ) : null}
            </div>
          )}

          <section className="local-models">
            <div className="mini-title">
              <HardDrive size={16} />
              <strong>Локальные модели</strong>
            </div>
            <div className="local-model-list">
              {localModels.map((model) => {
                const info = providers.find((item) => item.id === model.providerId);
                const installDisabled = model.status === "api" || model.status === "ready" || model.status === "installing" || model.status === "install_queued";
                const testDisabled = model.status === "api" || model.status === "not_installed" || model.status === "installing" || model.status === "install_queued";
                const openDisabled = !model.localPath || model.status === "api";

                return (
                  <div className="local-model-row" key={model.providerId}>
                    <div className="local-model-main">
                      <strong>{info?.name ?? model.providerId}</strong>
                      <span>{model.stage}</span>
                    </div>
                    <div className="local-model-meta">
                      <span className={`model-status ${model.status}`}>{statusLabel(model.status)}</span>
                      <span>{model.diskUsageBytes ? formatBytes(model.diskUsageBytes) : model.modelSizeHint}</span>
                    </div>
                    <div className="local-model-actions">
                      <button type="button" disabled={installDisabled} onClick={() => queueModelAction(model.providerId, "install").catch(console.error)}>
                        Install
                      </button>
                      <button type="button" disabled={testDisabled} onClick={() => queueModelAction(model.providerId, "test").catch(console.error)}>
                        Test
                      </button>
                      <button type="button" disabled={openDisabled} title={model.localPath || "Folder is not known yet"} onClick={() => queueModelAction(model.providerId, "open_folder").catch(console.error)}>
                        <FolderOpen size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="segmented">
            {(["draft", "standard", "production"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={quality === item ? "active" : ""}
                onClick={() => setQuality(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <label className="upload-zone">
            <UploadCloud size={20} />
            <span>{refs.length ? `${refs.length} reference image(s)` : "Добавить референсы"}</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => setRefs(Array.from(event.target.files ?? []))}
            />
          </label>

          <div className="format-grid">
            {formats.map((format) => (
              <label key={format} className="check-tile">
                <input
                  type="checkbox"
                  checked={targetFormats.includes(format)}
                  onChange={() => toggleFormat(format)}
                />
                <span>{format.toUpperCase()}</span>
              </label>
            ))}
          </div>

          <div className="switches">
            <Toggle checked={pbr} onChange={setPbr} label="PBR" />
            <Toggle checked={rigging} onChange={setRigging} label="Rig" />
            <Toggle checked={optimize} onChange={setOptimize} label="Game-ready" />
          </div>

          <label className="field compact">
            <span>Polycount</span>
            <input
              type="number"
              min={1000}
              step={1000}
              value={polycount}
              onChange={(event) => setPolycount(Number(event.target.value))}
            />
          </label>

          <button className="primary-button" disabled={submitting || !canSubmit}>
            {submitting ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            {!canGenerateWithProvider ? "Needs generated mesh" : needsReference && !refs.length ? "Add reference image" : "Generate"}
          </button>
        </form>

        <section className="panel queue">
          <div className="panel-title">
            <Settings2 size={18} />
            <h2>Очередь</h2>
          </div>
          <div className="job-list">
            {jobs.map((job) => (
              <button
                key={job.id}
                className={`job-card ${selectedJob?.id === job.id ? "selected" : ""}`}
                onClick={() => setSelectedId(job.id)}
              >
                <div className="job-card-head">
                  <StatusIcon status={job.status} />
                  <strong>{job.provider}</strong>
                  <span>{job.quality}</span>
                </div>
                <p>{job.prompt}</p>
                <div className="progress">
                  <span style={{ width: `${job.progress}%` }} />
                </div>
                <small>{job.stage}</small>
              </button>
            ))}
            {!jobs.length && <div className="empty">Заданий пока нет</div>}
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="preview-head">
            <div className="panel-title">
              <ImagePlus size={18} />
              <h2>Preview / Export</h2>
            </div>
            {selectedJob && <span className={`status-pill ${selectedJob.status}`}>{selectedJob.status}</span>}
          </div>

          <ThreePreview artifact={firstModelArtifact(selectedJob)} />

          {selectedJob?.error ? (
            <div className="job-error">
              <strong>Error</strong>
              <span>{selectedJob.error}</span>
            </div>
          ) : null}

          {selectedJob && (
            <div className="details">
              <div>
                <span>ID</span>
                <strong>{selectedJob.id}</strong>
              </div>
              <div>
                <span>References</span>
                <strong>{selectedJob.referenceImages.length}</strong>
              </div>
              <div>
                <span>Formats</span>
                <strong>{selectedJob.targetFormats.join(", ")}</strong>
              </div>
            </div>
          )}

          <div className="artifact-list">
            {(selectedJob?.artifacts ?? []).map((artifact) => (
              <a key={artifact.id} className="artifact-link" href={artifact.url} download>
                <Download size={16} />
                <span>{artifact.name}</span>
                <strong>{artifact.format}</strong>
              </a>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span />
      {label}
    </label>
  );
}

function StatusIcon({ status }: { status: AssetJob["status"] }) {
  if (status === "completed") return <CheckCircle2 className="ok" size={17} />;
  if (status === "running" || status === "claimed" || status === "uploading") return <Loader2 className="spin" size={17} />;
  if (status === "failed" || status === "cancelled") return <PauseCircle className="bad" size={17} />;
  return <Play size={17} />;
}

function firstModelArtifact(job?: AssetJob): Artifact | undefined {
  return job?.artifacts.find((artifact) => ["glb", "gltf", "obj"].includes(artifact.format));
}

function formatBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusLabel(status: LocalModelState["status"]) {
  const labels: Record<LocalModelState["status"], string> = {
    not_installed: "Not installed",
    install_queued: "Queued",
    installing: "Downloading",
    installed: "Installed",
    testing: "Testing",
    ready: "Ready",
    failed: "Failed",
    api: "API"
  };
  return labels[status];
}

function ThreePreview({ artifact }: { artifact?: Artifact }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [viewerMessage, setViewerMessage] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setViewerMessage(artifact ? "Loading preview..." : "Preview placeholder");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f8fafc");

    const target = new THREE.Vector3(0, 0.55, 0);
    const camera = new THREE.PerspectiveCamera(40, Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1), 0.05, 200);
    camera.position.set(3.4, 2.8, 4.8);
    camera.lookAt(target);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.copy(target);
    controls.minDistance = 1.2;
    controls.maxDistance = 18;
    controls.update();

    const key = new THREE.DirectionalLight("#ffffff", 2.4);
    key.position.set(4, 5, 4);
    scene.add(key);
    scene.add(new THREE.AmbientLight("#ffffff", 1.25));

    const grid = new THREE.GridHelper(7, 14, "#94a3b8", "#d1d5db");
    grid.position.y = -0.02;
    scene.add(grid);

    const root = new THREE.Group();
    scene.add(root);

    const defaultMaterial = new THREE.MeshStandardMaterial({ color: "#14b8a6", roughness: 0.45, metalness: 0.18 });
    const fallback = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), defaultMaterial);
    fallback.rotation.set(0.22, 0.42, 0.1);

    if (!artifact) {
      root.add(fallback);
      setViewerMessage("");
    } else if (artifact.format === "obj") {
      new OBJLoader().load(artifact.url, (object) => {
        object.traverse((child) => {
          if (child instanceof THREE.Mesh) child.material = defaultMaterial;
        });
        normalizeObject(object);
        root.add(object);
        setViewerMessage("");
      }, undefined, () => {
        root.add(fallback);
        setViewerMessage("Could not load model preview");
      });
    } else {
      new GLTFLoader().load(artifact.url, (gltf) => {
        normalizeObject(gltf.scene);
        root.add(gltf.scene);
        setViewerMessage("");
      }, undefined, () => {
        root.add(fallback);
        setViewerMessage("Could not load model preview");
      });
    }

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    window.addEventListener("resize", resize);

    let raf = 0;
    const tick = () => {
      root.rotation.y += 0.006;
      controls.update();
      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(tick);
    };
    tick();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [artifact?.url]);

  return (
    <div className="viewer-wrap">
      <div className="viewer" ref={hostRef} />
      {viewerMessage ? <div className="viewer-message">{viewerMessage}</div> : null}
    </div>
  );
}

function normalizeObject(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  object.scale.multiplyScalar(size > 0 ? 2.25 / size : 1);
}
