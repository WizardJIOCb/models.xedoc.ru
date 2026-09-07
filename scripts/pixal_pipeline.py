"""Local Pixal3D adapter. The caller owns the shared GPU queue and authentication."""
import argparse
import asyncio
import json
import inspect
import struct
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import aiohttp
from PIL import Image, ImageOps


TEMPLATE = Path(__file__).resolve().parent.parent / "config" / "pixal3d-api.json"
STAGES = {
    "192": "background", "312": "background", "56": "camera",
    "3": "structure", "18": "geometry", "23": "geometry_detail",
    "92": "geometry_decode", "12": "texture", "93": "texture_decode",
    "241": "remesh", "186": "decimate", "196": "uv",
    "147": "texture_bake", "224": "normal_bake", "322": "export",
}


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def glb_summary(path):
    with path.open("rb") as handle:
        header = handle.read(20)
        if len(header) != 20:
            raise ValueError("Generated GLB is truncated")
        magic, version, total, size, kind = struct.unpack("<4sIIII", header)
        if magic != b"glTF" or version != 2 or total != path.stat().st_size or kind != 0x4E4F534A:
            raise ValueError("Generated file is not a complete glTF 2 GLB")
        if size > 16 * 1024 * 1024:
            raise ValueError("Generated GLB JSON header is too large")
        document = json.loads(handle.read(size))
    triangles = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) == 4:
                accessor = primitive.get("indices", primitive["attributes"]["POSITION"])
                triangles += document["accessors"][accessor]["count"] // 3
    return {"bytes": total, "triangles": triangles, "meshes": len(document.get("meshes", [])),
            "skins": len(document.get("skins", [])),
            "animations": [a.get("name", "Animation") for a in document.get("animations", [])]}


def build_prompt(image_name, job_id, seed, quality="standard"):
    if quality not in ("standard", "high"):
        raise ValueError("quality must be standard or high")
    if type(seed) is not int or not 0 <= seed <= 2**32 - 1:
        raise ValueError("seed must be an unsigned 32-bit integer")
    uuid.UUID(job_id)
    prompt = json.loads(TEMPLATE.read_text(encoding="utf-8-sig"))
    prompt["122"]["inputs"]["image"] = image_name
    for offset, node in enumerate(("3", "18", "23", "12")):
        prompt[node]["inputs"]["seed"] = (seed + offset) % 2**32
    prompt["322"]["inputs"]["filename_prefix"] = f"generated-models/{job_id}/model"
    detailed = quality == "high"
    prompt["241"]["inputs"]["resolution"] = 512 if detailed else 384
    prompt["186"]["inputs"]["target_face_count"] = 200000 if detailed else 100000
    prompt["288"]["inputs"]["value"] = 4096 if detailed else 2048
    prompt["196"]["inputs"]["resolution"] = 4096 if detailed else 2048
    prompt["224"]["inputs"]["resolution"] = 2048 if detailed else 1024
    return prompt


class ComfyPipeline:
    def __init__(self, base_url="http://127.0.0.1:8188", callback=None):
        parsed = urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("ComfyUI must be an HTTP endpoint on this computer")
        self.base = base_url.rstrip("/")
        self.callback = callback or (lambda state: None)

    async def _json(self, session, method, route, **kwargs):
        async with session.request(method, self.base + route, **kwargs) as response:
            data = await response.json()
            if response.status >= 400:
                raise RuntimeError(f"ComfyUI {route}: HTTP {response.status}: {str(data)[:1500]}")
            return data

    async def health(self):
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            info = await self._json(session, "GET", "/object_info")
            template = json.loads(TEMPLATE.read_text(encoding="utf-8-sig"))
            missing_nodes = sorted({n["class_type"] for n in template.values()} - info.keys())
            missing_models = []
            for node in template.values():
                if node["class_type"] not in info:
                    continue
                required = info[node["class_type"]].get("input", {}).get("required", {})
                for key in ("unet_name", "vae_name", "clip_name", "model_name", "bg_removal_name"):
                    if key not in node["inputs"]:
                        continue
                    allowed = required.get(key, [[]])[0]
                    if isinstance(allowed, list) and node["inputs"][key] not in allowed:
                        missing_models.append(node["inputs"][key])
            return {"ready": not missing_nodes and not missing_models, "missing_nodes": missing_nodes,
                    "missing_models": sorted(set(missing_models))}

    async def run(self, job_dir, image, seed, quality="standard", timeout_seconds=1800):
        job_dir = Path(job_dir).resolve()
        job_dir.mkdir(parents=True, exist_ok=True)
        state_path = job_dir / "comfy-state.json"
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state["status"] == "complete":
                glb_summary(job_dir / "model.glb")
                return state
            if state["status"] == "failed":
                raise RuntimeError(state.get("error", "This job has failed; create a new job to retry"))
        else:
            state = {"job_id": str(uuid.uuid4()), "client_id": str(uuid.uuid4()),
                     "prompt_id": None, "status": "preparing", "stage": "preparing",
                     "created_at": time.time(), "seed": seed, "quality": quality}

        async def publish(**changes):
            state.update(changes, updated_at=time.time())
            write_json(state_path, state)
            notification = self.callback(dict(state))
            if inspect.isawaitable(notification):
                await notification

        await publish()
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=90)) as session:
            try:
                if state["status"] == "submitting" and not state["prompt_id"]:
                    # A previous POST may have succeeded before the process stopped. Recover by client id.
                    queue = await self._json(session, "GET", "/queue")
                    for item in queue.get("queue_running", []) + queue.get("queue_pending", []):
                        if item[3].get("client_id") == state["client_id"]:
                            await publish(prompt_id=item[1], status="running")
                            break
                    if not state["prompt_id"]:
                        history = await self._json(session, "GET", "/history?max_items=200")
                        for prompt_id, entry in history.items():
                            if entry.get("prompt", [None] * 4)[3].get("client_id") == state["client_id"]:
                                await publish(prompt_id=prompt_id, status="running")
                                break
                    if not state["prompt_id"]:
                        raise RuntimeError("Previous submission outcome is unknown; it was not submitted again")

                if not state["prompt_id"]:
                    queue = await self._json(session, "GET", "/queue")
                    if queue.get("queue_running") or queue.get("queue_pending"):
                        raise RuntimeError("ComfyUI is busy. Wait for its current task and retry")
                    image_path = job_dir / "input.png"
                    with Image.open(image) as source:
                        if source.width * source.height > 40_000_000:
                            raise ValueError("Image must contain at most 40 megapixels")
                        ImageOps.exif_transpose(source).convert("RGBA").save(image_path)
                    with image_path.open("rb") as handle:
                        form = aiohttp.FormData()
                        form.add_field("image", handle, filename=f'{state["job_id"]}.png', content_type="image/png")
                        form.add_field("type", "input")
                        form.add_field("subfolder", "generated-models")
                        form.add_field("overwrite", "false")
                        uploaded = await self._json(session, "POST", "/upload/image", data=form)
                    image_name = "/".join(filter(None, (uploaded.get("subfolder"), uploaded["name"])))
                    prompt = build_prompt(image_name, state["job_id"], state["seed"], state["quality"])
                    write_json(job_dir / "workflow-api.json", prompt)
                    await publish(status="submitting", stage="queued")
                    submitted = await self._json(session, "POST", "/prompt", json={"prompt": prompt, "client_id": state["client_id"]})
                    await publish(prompt_id=submitted["prompt_id"], status="running")

                await self._wait(session, job_dir, state, publish, timeout_seconds)
                return state
            except (aiohttp.ClientError, asyncio.TimeoutError) as error:
                # Keep submission identity so restarting this worker reconciles history without another generation.
                await publish(connection_error=str(error) or type(error).__name__, stage="reconnecting")
                raise
            except (RuntimeError, ValueError, OSError) as error:
                await publish(status="failed", error=str(error))
                raise

    async def _wait(self, session, job_dir, state, publish, timeout_seconds):
        started = time.monotonic()
        missing_queue_since = None
        ws = None
        last_poll = 0
        try:
            while time.monotonic() - started < timeout_seconds:
                if ws is None or ws.closed:
                    try:
                        ws = await session.ws_connect(self.base.replace("http:", "ws:") + "/ws", params={"clientId": state["client_id"]}, heartbeat=20)
                    except (aiohttp.ClientError, asyncio.TimeoutError):
                        ws = None
                if time.monotonic() - last_poll >= 2:
                    last_poll = time.monotonic()
                    history = await self._json(session, "GET", "/history/" + state["prompt_id"])
                    entry = history.get(state["prompt_id"])
                    if entry:
                        write_json(job_dir / "comfy-history.json", entry)
                        if entry.get("status", {}).get("status_str") != "success":
                            errors = [data for kind, data in entry.get("status", {}).get("messages", []) if kind in ("execution_error", "execution_interrupted")]
                            detail = errors[-1].get("exception_message", "Generation interrupted") if errors else "Generation failed"
                            raise RuntimeError(detail)
                        result = entry.get("outputs", {}).get("322", {}).get("result", [])
                        if not result or not isinstance(result[0], str):
                            raise RuntimeError("ComfyUI finished without a saved GLB")
                        await self._download(session, result[0], job_dir / "model.glb")
                        await publish(status="complete", stage="complete", result="model.glb", stats=glb_summary(job_dir / "model.glb"),
                                elapsed_seconds=round(time.time() - state["created_at"], 2))
                        return
                    queue = await self._json(session, "GET", "/queue")
                    present = any(item[1] == state["prompt_id"] for item in queue.get("queue_running", []) + queue.get("queue_pending", []))
                    if present:
                        missing_queue_since = None
                    elif missing_queue_since is None:
                        missing_queue_since = time.monotonic()
                    elif time.monotonic() - missing_queue_since > 20:
                        raise RuntimeError("ComfyUI no longer has this task. It may have restarted; create a new generation")
                if ws is None:
                    await asyncio.sleep(1)
                    continue
                try:
                    message = await ws.receive(timeout=1)
                except asyncio.TimeoutError:
                    continue
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                event = json.loads(message.data)
                data = event.get("data", {})
                if data.get("prompt_id") != state["prompt_id"]:
                    continue
                if event.get("type") == "executing" and data.get("node"):
                    node = str(data["node"])
                    await publish(node=node, stage=STAGES.get(node, state["stage"]), step=None, steps=None)
                elif event.get("type") == "progress":
                    await publish(step=data.get("value"), steps=data.get("max"))
                elif event.get("type") in ("execution_error", "execution_interrupted"):
                    raise RuntimeError(data.get("exception_message", "Generation interrupted"))
            raise asyncio.TimeoutError("Timed out waiting; task identity is retained for recovery")
        finally:
            if ws and not ws.closed:
                await ws.close()

    async def _download(self, session, relative, destination):
        relative = PurePosixPath(relative.replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts or relative.suffix.lower() != ".glb":
            raise RuntimeError("ComfyUI returned an invalid output path")
        params = {"filename": relative.name, "subfolder": str(relative.parent), "type": "output"}
        part = destination.with_suffix(".glb.part")
        total = 0
        async with session.get(self.base + "/view", params=params) as response:
            response.raise_for_status()
            with part.open("wb") as handle:
                async for chunk in response.content.iter_chunked(1024 * 1024):
                    total += len(chunk)
                    if total > 512 * 1024 * 1024:
                        raise RuntimeError("Generated GLB exceeds 512 MB")
                    handle.write(chunk)
        glb_summary(part)
        part.replace(destination)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--quality", choices=("standard", "high"), default="standard")
    parser.add_argument("--base-url", default="http://127.0.0.1:8188")
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args()
    client = ComfyPipeline(args.base_url, lambda value: print(json.dumps(value, ensure_ascii=False), flush=True))
    if args.health:
        print(json.dumps(await client.health(), ensure_ascii=False))
    elif args.job_dir and args.image:
        await client.run(args.job_dir, args.image, args.seed, args.quality)
    else:
        parser.error("--job-dir and --image are required for generation")


if __name__ == "__main__":
    asyncio.run(main())
