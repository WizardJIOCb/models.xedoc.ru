"""Fit an approximate 17-bone rig to a frontal, upright humanoid with separated limbs.

Run in Blender: blender --background --python rig_humanoid.py -- --input model.glb --output-dir out
This geometric fitter does not recognize arbitrary objects or replace a production autorigger.
"""
import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_rig import fit_posed
from manual_rig import fit_manual


def split_slice(points, triangles, z, pieces):
    section = points[np.abs(points[:, 2] - z) < 0.035]
    if len(section) < 60:
        raise ValueError("The body silhouette has too little geometry at a required joint")
    crossing = triangles[(triangles[:, :, 2].min(1) < z) & (triangles[:, :, 2].max(1) > z)]
    if not len(crossing):
        raise ValueError("A required body cross-section is missing")
    intersections = []
    for first, second in ((0, 1), (1, 2), (2, 0)):
        a, b = crossing[:, first], crossing[:, second]
        intersects = (a[:, 2] - z) * (b[:, 2] - z) <= 0
        denominator = b[:, 2] - a[:, 2]
        t = np.divide(z - a[:, 2], denominator, out=np.zeros_like(denominator), where=np.abs(denominator) > 1e-12)
        x = a[:, 0] + t * (b[:, 0] - a[:, 0])
        intersections.append(np.where(intersects, x, np.nan))
    values = np.array(intersections).T
    intervals = np.column_stack((np.nanmin(values, axis=1), np.nanmax(values, axis=1)))
    intervals = intervals[np.argsort(intervals[:, 0])]
    occupied = []
    for low, high in intervals:
        if occupied and low < occupied[-1][1] + 0.004:
            occupied[-1][1] = max(occupied[-1][1], float(high))
        else:
            occupied.append([float(low), float(high)])
    candidates = sorted(((occupied[i + 1][0] - occupied[i][1], (occupied[i + 1][0] + occupied[i][1]) / 2)
                         for i in range(len(occupied) - 1)), reverse=True)
    cuts = []
    for gap, x in candidates:
        if gap < 0.02:
            break
        proportion = float(np.mean(section[:, 0] < x))
        if proportion < 0.055 or proportion > 0.945:
            continue
        if pieces == 2 and abs(x) > 0.14:
            continue
        if pieces == 3 and not 0.15 < abs(x) < 0.75:
            continue
        if pieces == 3 and any(x * old_x > 0 for old_x in cuts):
            continue
        cuts.append(float(x))
        if len(cuts) == pieces - 1:
            break
    if len(cuts) != pieces - 1:
        detail = "Both legs must be visibly separated" if pieces == 2 else "Both arms must hang apart from the torso in a relaxed A pose"
        raise ValueError(detail)
    cuts.sort()
    boundaries = [-np.inf, *cuts, np.inf]
    groups = [section[(section[:, 0] >= low) & (section[:, 0] < high)] for low, high in zip(boundaries, boundaries[1:])]
    return groups, cuts


def fit_skeleton(points, triangles):
    size = np.ptp(points, axis=0)
    if not (0.45 < size[0] < 1.65 and 0.12 < size[1] < 1.05):
        raise ValueError("Use a single full-body humanoid facing the camera, standing upright with arms down and feet apart")
    leg_groups, _ = split_slice(points, triangles, 0.50, 2)
    split_slice(points, triangles, 0.72, 2)
    arms, arm_cuts = split_slice(points, triangles, 1.25, 3)
    torso_points = arms[1]
    torso_center = np.median(torso_points, axis=0)
    crotch = 0.72
    for z in np.arange(0.75, 1.14, 0.025):
        try:
            split_slice(points, triangles, z, 2)
            crotch = float(z)
        except ValueError:
            break
    hip_z = min(1.12, max(0.96, crotch + 0.075))

    def center(z, low_x, high_x, band=0.055):
        selected = points[(np.abs(points[:, 2] - z) < band) & (points[:, 0] > low_x) & (points[:, 0] < high_x)]
        if len(selected) < 15:
            raise ValueError("Could not place a joint inside this silhouette; use an upright A-pose reference")
        result = np.median(selected, axis=0)
        result[2] = z
        return result

    body_y = float(torso_center[1])
    hips = np.array([float(torso_center[0]), body_y, hip_z])
    spine = center(hip_z + (1.67 - hip_z) * 0.28, arm_cuts[0], arm_cuts[1])
    chest = center(hip_z + (1.67 - hip_z) * 0.64, arm_cuts[0], arm_cuts[1])
    neck = center(1.70, -0.19, 0.19)
    head = center(1.79, -0.24, 0.24)
    head_top = center(1.96, -0.26, 0.26)
    spec = {
        "Hips": (hips, spine, None), "Spine": (spine, chest, "Hips"),
        "Chest": (chest, neck, "Spine"), "Neck": (neck, head, "Chest"),
        "Head": (head, head_top, "Neck"),
    }
    for suffix, sign, arm_group, leg_group, cut in (
        ("L", 1, arms[2], leg_groups[1], arm_cuts[1]),
        ("R", -1, arms[0], leg_groups[0], arm_cuts[0]),
    ):
        low_x, high_x = (cut, 2) if sign > 0 else (-2, cut)
        region = points[(points[:, 0] * sign > abs(cut) + 0.025) & (points[:, 2] > 0.66) & (points[:, 2] < 1.79)]
        if len(region) < 30:
            raise ValueError("Both complete arms must be separate from the torso")
        hand_bottom = float(np.quantile(region[:, 2], 0.025))
        wrist_z = min(1.22, max(0.9, hand_bottom + 0.14))
        shoulder_z = min(1.66, max(1.52, float(np.quantile(region[:, 2], 0.93)) - 0.045))
        elbow_z = (shoulder_z + wrist_z) * 0.5
        shoulder = center(shoulder_z, low_x, high_x, 0.09)
        elbow = center(elbow_z, low_x, high_x)
        wrist = center(wrist_z, low_x, high_x)
        hand_tip = center(hand_bottom + 0.04, low_x, high_x, 0.08)
        hand_tip[2] = min(hand_tip[2], wrist_z - 0.07)
        leg_low, leg_high = (0.025, abs(cut)) if sign > 0 else (-abs(cut), -0.025)
        hip = center(hip_z - 0.02, leg_low, leg_high, 0.10)
        hip[2] = hip_z
        knee_z = hip_z * 0.57
        knee = center(knee_z, leg_low, leg_high)
        ankle = center(0.16, leg_low, leg_high, 0.065)
        sole = points[(points[:, 2] < 0.10) & (points[:, 0] > leg_low) & (points[:, 0] < leg_high)]
        if len(sole) < 15:
            raise ValueError("Both complete feet must be visible")
        toe = np.array([ankle[0], np.quantile(sole[:, 1], 0.1), 0.05])
        if np.linalg.norm(toe - ankle) < 0.10:
            toe[1] = ankle[1] - 0.13
        spec.update({
            f"UpperArm_{suffix}": (shoulder, elbow, "Chest"),
            f"LowerArm_{suffix}": (elbow, wrist, f"UpperArm_{suffix}"),
            f"Hand_{suffix}": (wrist, hand_tip, f"LowerArm_{suffix}"),
            f"UpperLeg_{suffix}": (hip, knee, "Hips"),
            f"LowerLeg_{suffix}": (knee, ankle, f"UpperLeg_{suffix}"),
            f"Foot_{suffix}": (ankle, toe, f"LowerLeg_{suffix}"),
        })
    diagnostics = {"method": "mesh cross-section fitting", "automatic_semantic_recognition": False,
                   "arm_separation_x_m": arm_cuts, "estimated_crotch_height_m": crotch,
                   "input_requirements": "One frontal upright humanoid, relaxed A pose, separate arms and legs, complete feet"}
    return spec, diagnostics


def make_weights(mesh, spec):
    names = list(spec)
    heads = np.asarray([spec[n][0] for n in names])
    tails = np.asarray([spec[n][1] for n in names])
    segments = tails - heads
    length2 = np.sum(segments * segments, axis=1)
    points = np.asarray([v.co[:] for v in mesh.data.vertices])
    groups = {n: mesh.vertex_groups.new(name=n) for n in names}
    counts = {n: 0 for n in names}
    for start in range(0, len(points), 4000):
        chunk = points[start:start + 4000]
        delta = chunk[:, None, :] - heads[None, :, :]
        t = np.clip(np.sum(delta * segments[None, :, :], axis=2) / length2[None, :], 0, 1)
        nearest = heads[None, :, :] + t[:, :, None] * segments[None, :, :]
        distances = np.linalg.norm(chunk[:, None, :] - nearest, axis=2)
        for column, name in enumerate(names):
            if name.endswith("_L"):
                distances[chunk[:, 0] < -0.015, column] += 5
            elif name.endswith("_R"):
                distances[chunk[:, 0] > 0.015, column] += 5
        order = np.argsort(distances, axis=1)[:, :3]
        for row, candidates in enumerate(order):
            closest = names[int(candidates[0])]
            connected = {closest, spec[closest][2]}
            connected.update(n for n in names if spec[n][2] == closest)
            candidates = [int(i) for i in candidates if names[int(i)] in connected]
            weights = np.array([1 / (distances[row, i] + 0.025)**6 for i in candidates])
            weights /= weights.sum()
            for index, weight in zip(candidates, weights):
                if weight > 0.0001:
                    groups[names[index]].add([start + row], float(weight), "REPLACE")
                    counts[names[index]] += 1
    if any(counts[name] < 5 for name in names):
        raise ValueError("The inferred skeleton could not bind every limb; preserve this model as a static mesh")
    # Normalize after removing negligible influences, to preserve glTF's skin contract exactly.
    for vertex in mesh.data.vertices:
        total = sum(group.weight for group in vertex.groups)
        for group in vertex.groups:
            mesh.vertex_groups[group.group].add([vertex.index], group.weight / total, "REPLACE")
    return counts


def make_heat_weights(mesh, rig, spec):
    """Use mesh topology so a raised forearm does not pull nearby torso vertices."""
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    counts = {name: 0 for name in spec}
    for vertex in mesh.data.vertices:
        influences = sorted(((group.group, group.weight) for group in vertex.groups
            if mesh.vertex_groups[group.group].name in spec and group.weight > 1e-5),
            key=lambda item: item[1], reverse=True)[:4]
        total = sum(weight for _, weight in influences)
        if total < 1e-6:
            raise ValueError('Bone heat left an unweighted vertex')
        keep = {group for group, _ in influences}
        for group in list(vertex.groups):
            if group.group not in keep:
                mesh.vertex_groups[group.group].remove([vertex.index])
        for group, weight in influences:
            mesh.vertex_groups[group].add([vertex.index], weight / total, 'REPLACE')
            counts[mesh.vertex_groups[group].name] += 1
    if any(count < 5 for count in counts.values()):
        raise ValueError('Bone heat did not bind every limb')
    return counts


def animate(rig, spec):
    def clear():
        for pose in rig.pose.bones:
            pose.rotation_mode = "QUATERNION"
            pose.rotation_quaternion = Quaternion()
            pose.location = (0, 0, 0)

    def rotate(name, axis, degrees):
        local_axis = rig.data.bones[name].matrix_local.to_quaternion().inverted() @ Vector(axis)
        rig.pose.bones[name].rotation_quaternion = Quaternion(local_axis, math.radians(degrees))

    def point(name, head, tail):
        rest = rig.data.bones[name]
        delta = (rest.tail_local - rest.head_local).rotation_difference(Vector(tail) - Vector(head))
        matrix = (delta @ rest.matrix_local.to_quaternion()).to_matrix().to_4x4()
        matrix.translation = Vector(head)
        rig.pose.bones[name].matrix = matrix
        bpy.context.view_layer.update()

    def leg(side, phase, drop):
        hip = Vector(spec[f"UpperLeg_{side}"][0]) + Vector((0, 0, drop))
        ankle = Vector(spec[f"Foot_{side}"][0])
        ankle.y -= 0.11 * math.cos(phase)
        ankle.z += 0.08 * max(0, -math.sin(phase))
        a = (Vector(spec[f"UpperLeg_{side}"][1]) - Vector(spec[f"UpperLeg_{side}"][0])).length
        b = (Vector(spec[f"LowerLeg_{side}"][1]) - Vector(spec[f"LowerLeg_{side}"][0])).length
        distance = min((ankle - hip).length, a + b - 0.0001)
        direction = (ankle - hip).normalized()
        ankle = hip + direction * distance
        along = (a*a - b*b + distance*distance) / (2 * distance)
        perpendicular = (Vector((0, -1, 0)) - direction * direction.dot(Vector((0, -1, 0)))).normalized()
        knee = hip + direction * along + perpendicular * math.sqrt(max(0, a*a - along*along))
        point(f"UpperLeg_{side}", hip, knee)
        point(f"LowerLeg_{side}", knee, ankle)
        foot_direction = Vector(spec[f"Foot_{side}"][1]) - Vector(spec[f"Foot_{side}"][0])
        point(f"Foot_{side}", ankle, ankle + foot_direction)

    clips = []
    for clip, frames in (("Idle", 90), ("Walk", 48)):
        clear()
        rig.animation_data_clear()
        for frame in range(1, frames + 2, 2):
            phase = 2 * math.pi * (frame - 1) / frames
            clear()
            if clip == "Idle":
                rotate("Spine", (1, 0, 0), 0.7 * math.sin(phase))
                rotate("Head", (0, 0, 1), 1.4 * math.sin(phase))
            else:
                drop = -0.065 + 0.004 * math.cos(2 * phase)
                rig.pose.bones["Hips"].location = rig.data.bones["Hips"].matrix_local.to_quaternion().inverted() @ Vector((0, 0, drop))
                bpy.context.view_layer.update()
                for side, offset in (("L", 0), ("R", math.pi)):
                    wave = math.sin(phase + offset)
                    leg(side, phase + offset, drop)
                    rotate(f"UpperArm_{side}", (1, 0, 0), -12 * wave)
                    rotate(f"LowerArm_{side}", (1, 0, 0), -7 - 5 * max(0, wave))
                rotate("Chest", (0, 0, 1), -2 * math.sin(phase))
            for pose in rig.pose.bones:
                pose.keyframe_insert("rotation_quaternion", frame=frame, group=pose.name)
                if pose.name == "Hips":
                    pose.keyframe_insert("location", frame=frame, group=pose.name)
        action = rig.animation_data.action
        action.name = clip
        action.use_fake_user = True
        clips.append(action)
    rig.animation_data_clear()
    clear()
    rig.animation_data_create()
    for action in clips:
        track = rig.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, 1, action)
        track.mute = True
    rig.animation_data.action = None
    return [action.name for action in clips]


def run(args):
    source = args.input.resolve()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise ValueError("The model contains no mesh")
    if any(obj.type == "ARMATURE" for obj in bpy.context.scene.objects):
        raise ValueError("This model already has a skeleton; preserve it instead of applying an approximate rig")
    bpy.ops.object.select_all(action="DESELECT")
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.view_layer.objects.active
    mesh.name = "GeneratedHumanoid"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    points = np.asarray([vertex.co[:] for vertex in mesh.data.vertices])
    # Match THREE.Euler(x,y,z,'XYZ') in glTF Y-up, then convert to Blender Z-up.
    coordinate = Quaternion((1, 0, 0), math.pi / 2)
    rotation = (Quaternion((1, 0, 0), math.radians(args.rotation_x)) @
                Quaternion((0, 1, 0), math.radians(args.rotation_y)) @
                Quaternion((0, 0, 1), math.radians(args.rotation_z)))
    matrix = np.asarray((coordinate @ rotation @ coordinate.inverted()).to_matrix())
    points = points @ matrix.T
    lo, hi = points.min(0), points.max(0)
    if hi[2] - lo[2] < 0.001:
        raise ValueError("The model has no upright height")
    offset = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    points = (points - offset) * (2 / (hi[2] - lo[2]))
    if args.facing == "back":
        points[:, :2] *= -1
    for vertex, point_value in zip(mesh.data.vertices, points):
        vertex.co = point_value
    mesh.data.calc_loop_triangles()
    triangle_indices = np.array([triangle.vertices[:] for triangle in mesh.data.loop_triangles])
    if args.manual_points:
        spec, diagnostics = fit_manual(json.loads(args.manual_points.read_text(encoding='utf-8')))
    else:
        try:
            spec, diagnostics = fit_skeleton(points, points[triangle_indices])
        except ValueError as geometric_error:
            spec, diagnostics = fit_posed(mesh, points, output)
            diagnostics['geometric_fallback_reason'] = str(geometric_error)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.000001)
    bpy.ops.object.mode_set(mode="OBJECT")
    before = len(mesh.data.polygons)
    if before > args.triangles:
        modifier = mesh.modifiers.new("WebGL geometry budget", "DECIMATE")
        modifier.ratio = args.triangles / before
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    mesh.data.validate(clean_customdata=False)
    for polygon in mesh.data.polygons:
        polygon.use_smooth = True
    for image in bpy.data.images:
        if image.type == "IMAGE" and image.size[0] > 0:
            if max(image.size) > 2048:
                factor = 2048 / max(image.size)
                image.scale(max(1, round(image.size[0]*factor)), max(1, round(image.size[1]*factor)))
            image.pack()
    bpy.ops.object.select_all(action="DESELECT")
    data = bpy.data.armatures.new("GeneratedHumanoidSkeleton")
    rig = bpy.data.objects.new("GeneratedHumanoidArmature", data)
    bpy.context.collection.objects.link(rig)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (head, tail, parent) in spec.items():
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = Vector(head), Vector(tail)
        bone.align_roll(Vector((0, 1, 0)))
        if parent:
            bone.parent = data.edit_bones[parent]
            bone.use_connect = (bone.head - bone.parent.tail).length < 1e-5
    bpy.ops.object.mode_set(mode="OBJECT")
    if diagnostics.get('automatic_semantic_recognition') or diagnostics.get('manual_landmarks'):
        try:
            counts = make_heat_weights(mesh, rig, spec)
            diagnostics['weight_method'] = 'Blender bone heat; strongest 4 normalized influences'
        except (ValueError, RuntimeError) as error:
            mesh.vertex_groups.clear()
            counts = make_weights(mesh, spec)
            diagnostics['weight_method'] = 'geometric fallback'
            diagnostics['weight_warning'] = str(error)
    else:
        counts = make_weights(mesh, spec)
        diagnostics['weight_method'] = 'geometric'
    mesh.parent = rig
    modifier = next((item for item in mesh.modifiers if item.type == 'ARMATURE' and item.object == rig), None)
    if modifier is None:
        modifier = mesh.modifiers.new("Approximate humanoid skin", "ARMATURE")
    modifier.object = rig
    clips = animate(rig, spec)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_set(1)
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    glb = output / "rigged.glb"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True,
        export_animations=True, export_animation_mode="ACTIONS", export_skins=True,
        export_all_influences=False, export_yup=True, export_apply=False, export_image_format="AUTO")
    raw = glb.read_bytes()
    document = json.loads(raw[20:20 + struct.unpack_from("<I", raw, 12)[0]])
    if len(document.get("skins", [])) != 1 or len(document["skins"][0]["joints"]) != 17:
        raise RuntimeError("Exported skeleton failed validation")
    mesh.data.calc_loop_triangles()
    def gltf(point):
        return [round(float(point[0]), 6), round(float(point[2]), 6), round(float(-point[1]), 6)]
    contract = {"coordinate_system": "glTF Y-up; model faces +Z; metres; left is +X", "height_m": 2.0, "root_bone": "Hips",
        "bones": [{"name": name, "parent": parent, "head": gltf(head), "tail": gltf(tail),
                   "length": float(np.linalg.norm(tail-head))} for name, (head, tail, parent) in spec.items()]}
    report = {"status": "complete", "rigged": True,
        "method": "manual-landmarks" if diagnostics.get('manual_landmarks') else "posed-landmarks" if diagnostics.get('automatic_semantic_recognition') else "humanoid-template",
        "rotation": {"x": args.rotation_x, "y": args.rotation_y, "z": args.rotation_z},
        "diagnostics": diagnostics, "triangles": len(mesh.data.loop_triangles), "vertices": len(mesh.data.vertices),
        "bones": 17, "bone_weighted_vertices": counts, "animation_clips": clips, "glb_bytes": len(raw),
        "unweighted_vertex_count": sum(not vertex.groups for vertex in mesh.data.vertices),
        "weight_sum_max_error": max(abs(sum(group.weight for group in vertex.groups) - 1) for vertex in mesh.data.vertices),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "glb_sha256": hashlib.sha256(raw).hexdigest(),
        "limitations": ["Weights are estimated from geometry; armor can bend incorrectly", "Hands have no separate finger bones",
                        "Idle and Walk are procedural previews, not SMPL-X RP generated motion", "Validate the pose before using this rig in a game"]}
    (output / "rig-contract.json").write_text(json.dumps(contract, indent=2), encoding="utf-8")
    (output / "rig-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "rigged.blend"), compress=True)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--triangles", type=int, default=50000)
    parser.add_argument("--manual-points", type=Path)
    parser.add_argument("--facing", choices=("front", "back"), default="front")
    for axis in 'xyz':
        parser.add_argument(f'--rotation-{axis}', type=float, default=0)
    arguments = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    try:
        run(arguments)
    except (ValueError, RuntimeError) as error:
        arguments.output_dir.mkdir(parents=True, exist_ok=True)
        result = {"status": "unsupported", "rigged": False, "error": str(error), "model_preserved": True}
        (arguments.output_dir / "rig-report.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result), flush=True)
        raise SystemExit(2)
