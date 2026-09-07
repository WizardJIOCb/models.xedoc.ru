"""Bake Kimodo SMPL-X22 F32 motion onto a skinned humanoid GLB in Blender.

Blender --background --python scripts/retarget_motion.py -- --input rigged.glb
  --root root.f32 --rotations rotations.f32 --frames 150 --fps 30
  --output animated.glb --name "Kimodo Motion"

The source streams use glTF Y-up metres and XYZW quaternions. Existing clips,
materials, skins and textures are retained. Source directions and paired arm
bend axes are calibrated to the input rest skeleton, including bent elbows.
"""
import argparse
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector


PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19]
OFFSETS = [
    (0, 0, 0), (.052299, -.093936, -.027607), (-.057193, -.106548, -.022218),
    (-.001496, .11293, -.024981), (.058867, -.416442, -.006557),
    (-.048074, -.39756, -.014061), (.0069, .145636, -.006859),
    (-.041738, -.437584, -.029512), (.014489, -.446853, -.01803),
    (-.010334, .056082, .021116), (.049294, -.065279, .126259),
    (-.040575, -.065287, .127076), (-.011026, .171365, -.028827),
    (.047725, .087643, -.008375), (-.046636, .086612, -.014864),
    (.024654, .175391, .024463), (.126285, .05768, -.013885),
    (-.109342, .053674, -.009118), (.272907, -.069853, -.039094),
    (-.292029, -.03544, -.024565), (.276174, .021254, -.002478),
    (-.271878, -.004835, -.016445),
]
# Source joint represented by each target bone, and a source rest direction.
JOINTS = {
    'Hips': (0, None), 'Spine': (3, 6), 'Chest': (9, 12),
    'Neck': (12, 15), 'Head': (15, 15),
    'UpperArm_L': (16, 18), 'LowerArm_L': (18, 20), 'Hand_L': (20, 20),
    'UpperArm_R': (17, 19), 'LowerArm_R': (19, 21), 'Hand_R': (21, 21),
    'UpperLeg_L': (1, 4), 'LowerLeg_L': (4, 7), 'Foot_L': (7, 10),
    'UpperLeg_R': (2, 5), 'LowerLeg_R': (5, 8), 'Foot_R': (8, 11),
}
ALIASES = {
    'Hips': ('Hips', 'pelvis', 'mixamorig:Hips'),
    'Spine': ('Spine', 'spine_01', 'mixamorig:Spine'),
    'Chest': ('Chest', 'spine_02', 'Spine2', 'mixamorig:Spine2'),
    'Neck': ('Neck', 'neck_01', 'mixamorig:Neck'),
    'Head': ('Head', 'head', 'mixamorig:Head'),
}
for _side, _long_side in [('L', 'Left'), ('R', 'Right')]:
    for _name, _other, _mixamo in [
        ('UpperArm', 'upperarm', 'Arm'), ('LowerArm', 'lowerarm', 'ForeArm'),
        ('Hand', 'hand', 'Hand'), ('UpperLeg', 'thigh', 'UpLeg'),
        ('LowerLeg', 'calf', 'Leg'), ('Foot', 'foot', 'Foot'),
    ]:
        ALIASES[f'{_name}_{_side}'] = (
            f'{_name}_{_side}', f'{_other}_{_side.lower()}',
            f'mixamorig:{_long_side}{_mixamo}', f'{_long_side}{_mixamo}',
        )


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('input', 'root', 'rotations', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--frames', type=int, required=True)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--name', default='Kimodo Motion')
    parser.add_argument('--root-scale', type=float, default=1.0)
    parser.add_argument('--no-ground', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    if not 1 <= args.frames <= 1000 or not 1 <= args.fps <= 120:
        parser.error('frames must be 1..1000 and fps must be 1..120')
    if not math.isfinite(args.root_scale) or not 0 < args.root_scale <= 10:
        parser.error('root-scale must be finite and 0 < value <= 10')
    for path in (args.input, args.root, args.rotations):
        if not path.is_file():
            parser.error(f'Input file does not exist: {path}')
    if args.input.resolve() == args.output.resolve():
        parser.error('output must differ from input')
    return args


def read_stream(path, shape):
    expected = int(np.prod(shape)) * 4
    raw = path.read_bytes()
    if len(raw) != expected:
        raise ValueError(f'{path.name}: expected {expected} bytes, got {len(raw)}')
    values = np.frombuffer(raw, dtype='<f4').reshape(shape)
    if not np.isfinite(values).all():
        raise ValueError(f'{path.name} contains non-finite values')
    return values


def mesh_world_vertices(mesh, depsgraph):
    evaluated = mesh.evaluated_get(depsgraph)
    vertices = np.empty(len(evaluated.data.vertices) * 3, dtype=np.float32)
    evaluated.data.vertices.foreach_get('co', vertices)
    matrix = np.array(evaluated.matrix_world, dtype=np.float64)
    return vertices.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3]


def glb_json(path):
    with path.open('rb') as stream:
        if stream.read(4) != b'glTF':
            raise ValueError('Exporter did not produce GLB')
        stream.seek(12)
        length, kind = struct.unpack('<II', stream.read(8))
        if kind != 0x4e4f534a:
            raise ValueError('Missing GLB JSON chunk')
        return json.loads(stream.read(length))


def direction_frame(direction, normal):
    """A bone frame with its Y along the bone and its Z along the bend axis."""
    along = direction.normalized()
    normal = normal - along * normal.dot(along)
    if normal.length < 1e-6:
        raise ValueError('Cannot calibrate an arm with a degenerate bend axis')
    normal.normalize()
    return Matrix((along.cross(normal), along, normal)).transposed().to_quaternion()


def paired_arm_corrections(directions, coordinate):
    """Constrain both arm directions and roll, including a bent elbow bind pose.

    A shortest arc for each bone separately leaves twist unconstrained. At a
    bent elbow those arcs can carry its shared hinge axis to unrelated axes.
    SMPL-X bends its elbows primarily around local Y; project that anatomical
    axis onto each source bone's perpendicular plane, since its measured rest
    offsets are not perfectly perpendicular to Y. This retains the exact source
    directions while making the unavoidable small rest-axis discrepancy
    independent of the target elbow's bind angle.
    """
    corrections = {}
    for side, sign in [('L', 1), ('R', -1)]:
        upper = directions[f'UpperArm_{side}'].normalized()
        lower = directions[f'LowerArm_{side}'].normalized()
        # The same negative-flexion convention is used by the native ragdoll.
        target_axis = lower.cross(upper)
        if target_axis.length <= .08:
            target_axis = (coordinate @ Vector((0, 0, 1))).cross(upper)
        if target_axis.length < 1e-6:
            target_axis = (coordinate @ Vector((0, 1, 0))).cross(upper)
        target_axis.normalize()
        source_axis = coordinate @ Vector((0, sign, 0))
        for part in ('UpperArm', 'LowerArm', 'Hand'):
            semantic = f'{part}_{side}'
            source_direction = coordinate @ Vector(OFFSETS[JOINTS[semantic][1]])
            source_frame = direction_frame(source_direction, source_axis)
            target_frame = direction_frame(directions[semantic], target_axis)
            corrections[semantic] = (source_frame @ target_frame.inverted()).normalized()
    return corrections


def main():
    args = parse_args()
    roots = read_stream(args.root, (args.frames, 3))
    rotations = read_stream(args.rotations, (args.frames, 22, 4))
    norms = np.linalg.norm(rotations, axis=2)
    if (norms < 1e-6).any():
        raise ValueError('A source quaternion has zero length')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # The importer converts seconds to scene frames. Set fps before importing so
    # existing Idle/Walk actions retain their original timing during re-export.
    bpy.context.scene.render.fps = args.fps
    bpy.ops.import_scene.gltf(filepath=str(args.input.resolve()))
    scene = bpy.context.scene
    rigs = [obj for obj in scene.objects if obj.type == 'ARMATURE']
    if len(rigs) != 1:
        raise ValueError(f'Expected one humanoid armature, found {len(rigs)}')
    rig = rigs[0]
    meshes = [obj for obj in scene.objects if obj.type == 'MESH' and any(
        modifier.type == 'ARMATURE' and modifier.object == rig for modifier in obj.modifiers)]
    if not meshes:
        raise ValueError('The GLB has no mesh skinned to its armature')
    existing_clips = {action.name for action in bpy.data.actions}
    if args.name in existing_clips:
        suffix = 2
        while f'{args.name} {suffix}' in existing_clips:
            suffix += 1
        args.name = f'{args.name} {suffix}'
    rig.animation_data_create()
    rig.animation_data.action = None
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    for bone in rig.pose.bones:
        bone.rotation_mode = 'QUATERNION'
        bone.matrix_basis.identity()
    scene.render.fps = args.fps
    scene.frame_start = 0
    scene.frame_end = args.frames
    scene.frame_set(0)
    bpy.context.view_layer.update()

    by_name = {bone.name.lower(): bone for bone in rig.pose.bones}
    resolved = {}
    for semantic, aliases in ALIASES.items():
        bone = next((by_name[alias.lower()] for alias in aliases if alias.lower() in by_name), None)
        if bone is None:
            raise ValueError(f'Humanoid bone is missing: {semantic}')
        resolved[semantic] = bone
    # Armature order is parents before children. Helpers not mapped stay in rest.
    semantic_by_name = {bone.name: semantic for semantic, bone in resolved.items()}
    ordered = sorted(rig.pose.bones, key=lambda bone: len(bone.parent_recursive))
    coordinate = Quaternion((1, 0, 0), math.pi / 2)  # (x,y,z) -> (x,-z,y)
    inverse_coordinate = coordinate.inverted()
    rig_world_rotation = rig.matrix_world.to_quaternion()
    rest_world = {bone.name: (rig_world_rotation @ bone.bone.matrix_local.to_quaternion()).normalized()
                  for bone in ordered}
    target_directions = {
        semantic: rig.matrix_world.to_3x3() @ (bone.bone.tail_local - bone.bone.head_local)
        for semantic, bone in resolved.items()
    }
    arm_corrections = paired_arm_corrections(target_directions, coordinate)
    corrections = {}
    for semantic, bone in resolved.items():
        child = JOINTS[semantic][1]
        if child is None:
            corrections[bone.name] = Quaternion()
        elif semantic in arm_corrections:
            corrections[bone.name] = arm_corrections[semantic]
        else:
            target_direction = target_directions[semantic]
            source_direction = coordinate @ Vector(OFFSETS[child])
            corrections[bone.name] = target_direction.normalized().rotation_difference(source_direction.normalized())
    hip = resolved['Hips']
    root_basis_inverse = hip.bone.matrix_local.to_quaternion().inverted()
    world_to_rig = rig.matrix_world.inverted().to_3x3()
    previous_quaternions = {}
    max_ground_lift = 0.0
    ground_rest_offset = 0.0
    lowest_before_ground = float('inf')
    sampled_bounds = []
    first_vertices = None
    max_skin_motion = 0.0
    sample_indices = set([0, args.frames // 3, 2 * args.frames // 3, args.frames - 1])

    for frame_index in range(args.frames):
        frame = frame_index
        scene.frame_set(frame)
        globals_source = []
        for joint in range(22):
            x, y, z, w = rotations[frame_index, joint]
            local = Quaternion((float(w), float(x), float(y), float(z))).normalized()
            parent = PARENTS[joint]
            globals_source.append(local if parent < 0 else globals_source[parent] @ local)
        desired_world = {}
        for bone in ordered:
            parent_rest = rest_world[bone.parent.name] if bone.parent else rig_world_rotation
            parent_desired = desired_world[bone.parent.name] if bone.parent else rig_world_rotation
            rest_local = parent_rest.inverted() @ rest_world[bone.name]
            semantic = semantic_by_name.get(bone.name)
            if semantic is None:
                desired_world[bone.name] = parent_desired @ rest_local
                bone.rotation_quaternion = Quaternion()
                continue
            source = globals_source[JOINTS[semantic][0]]
            delta_world = coordinate @ source @ inverse_coordinate
            world = delta_world @ corrections[bone.name] @ rest_world[bone.name]
            desired_world[bone.name] = world
            basis = (rest_local.inverted() @ parent_desired.inverted() @ world).normalized()
            previous = previous_quaternions.get(bone.name)
            if previous is not None and previous.dot(basis) < 0:
                basis.negate()
            previous_quaternions[bone.name] = basis.copy()
            bone.rotation_quaternion = basis
            bone.location = (0, 0, 0)
            bone.scale = (1, 1, 1)
        delta_root_world = coordinate @ Vector((roots[frame_index] - roots[0]).tolist()) * args.root_scale
        delta_root_world.z += ground_rest_offset
        hip.location = root_basis_inverse @ (world_to_rig @ delta_root_world)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        minimum = min(float(mesh_world_vertices(mesh, depsgraph)[:, 2].min()) for mesh in meshes)
        if frame_index == 0 and not args.no_ground:
            # Calibrate the first sole height once. Subsequent positive heights
            # are retained, so jumps are not flattened onto the floor.
            ground_rest_offset = .002 - minimum
            hip.location += root_basis_inverse @ (world_to_rig @ Vector((0, 0, ground_rest_offset)))
            minimum += ground_rest_offset
            bpy.context.view_layer.update()
        lowest_before_ground = min(lowest_before_ground, minimum)
        lift = max(0.0, .002 - minimum) if not args.no_ground else 0.0
        if lift:
            hip.location += root_basis_inverse @ (world_to_rig @ Vector((0, 0, lift)))
            max_ground_lift = max(max_ground_lift, lift)
            bpy.context.view_layer.update()
        for bone in resolved.values():
            bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
        hip.keyframe_insert('location', frame=frame, group=hip.name)
        if frame_index in sample_indices:
            depsgraph = bpy.context.evaluated_depsgraph_get()
            vertices = np.concatenate([mesh_world_vertices(mesh, depsgraph) for mesh in meshes])
            if first_vertices is None:
                first_vertices = vertices.copy()
            max_skin_motion = max(max_skin_motion, float(np.linalg.norm(vertices - first_vertices, axis=1).max()))
            sampled_bounds.append({'frame': frame, 'min': vertices.min(axis=0).tolist(),
                                   'max': vertices.max(axis=0).tolist(), 'ground_lift_m': lift})
        if (frame_index + 1) % 30 == 0 or frame_index == args.frames - 1:
            print(f'RETARGET {frame_index + 1}/{args.frames}', flush=True)

    action = rig.animation_data.action
    action.name = args.name
    action.use_fake_user = True
    # Hold the final sample for one sample period: N samples at 30 fps play for N/30 seconds.
    for bone in resolved.values():
        bone.keyframe_insert('rotation_quaternion', frame=args.frames, group=bone.name)
    hip.keyframe_insert('location', frame=args.frames, group=hip.name)
    for layer in action.layers:
        for strip in layer.strips:
            for channelbag in strip.channelbags:
                for curve in channelbag.fcurves:
                    for point in curve.keyframe_points:
                        point.interpolation = 'LINEAR'
    track = rig.animation_data.nla_tracks.new()
    track.name = action.name
    strip = track.strips.new(action.name, 0, action)
    strip.name = action.name
    track.mute = True
    rig.animation_data.action = None
    for bone in rig.pose.bones:
        bone.matrix_basis.identity()
    scene.frame_set(0)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(args.output.resolve()), export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS', export_skins=True,
        export_all_influences=False, export_yup=True, export_apply=False,
        export_image_format='AUTO', export_frame_range=False,
    )
    document = glb_json(args.output)
    exported = {clip.get('name') for clip in document.get('animations', [])}
    if not (existing_clips | {args.name}).issubset(exported):
        raise RuntimeError(f'Animation clips were lost during export: {existing_clips}, {exported}')
    if not document.get('skins') or not all(
        'JOINTS_0' in primitive['attributes'] and 'WEIGHTS_0' in primitive['attributes']
        for mesh in document.get('meshes', []) for primitive in mesh['primitives']
    ):
        raise RuntimeError('Export did not retain mesh skinning')
    clip = next(clip for clip in document['animations'] if clip.get('name') == args.name)
    duration = max(document['accessors'][sampler['input']]['max'][0] for sampler in clip['samplers'])
    report = {
        'success': True, 'input': str(args.input.resolve()), 'output': str(args.output.resolve()),
        'clip': args.name, 'preserved_clips': sorted(existing_clips), 'exported_clips': sorted(exported),
        'source_frames': args.frames, 'fps': args.fps, 'duration_seconds': duration,
        'coordinate_system': 'glTF Y-up metres, +Z forward; Blender internally (x,-z,y)',
        'rest_pose_alignment': 'SMPL-X source bone directions calibrated to target rest; paired arm bend-axis calibration',
        'root_scale': args.root_scale, 'root_translation': 'relative to first source frame',
        'root_displacement_source_m': (roots[-1] - roots[0]).tolist(),
        'skinned_meshes': len(meshes), 'bone_count': len(rig.data.bones),
        'skin_vertex_displacement_max_m': max_skin_motion,
        'ground_correction': not args.no_ground, 'minimum_before_ground_m': lowest_before_ground,
        'ground_rest_offset_m': ground_rest_offset,
        'maximum_ground_lift_m': max_ground_lift, 'sampled_bounds_blender': sampled_bounds,
        'file_bytes': args.output.stat().st_size,
    }
    report_path = args.report or args.output.with_suffix('.retarget.json')
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
