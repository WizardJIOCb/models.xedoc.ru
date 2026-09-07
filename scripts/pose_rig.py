"""Fit a posed humanoid from local orthographic renders and semantic landmarks.

Runs inside Blender. MediaPipe runs in a separate CPU Python environment. Its
2D landmarks are triangulated using the actual render cameras, then checked
against the mesh. We do not assume the photograph and generated mesh coincide.
"""
import json
import math
import os
import subprocess
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from pose_geometry import triangulate_joint

POSE_PYTHON = Path(os.environ.get('STUDIO_POSE_PYTHON', r'C:\Projects\models-studio-tools\pose\.venv\Scripts\python.exe'))
POSE_MODEL = Path(os.environ.get('STUDIO_POSE_MODEL', r'C:\Projects\models-studio-models\Pose\pose_landmarker_heavy.task'))


def render_views(mesh, output, angles=(0, -35, 35)):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new('Pose neutral background')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.55, 0.55, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    lights = []
    for location, energy, size in [((-3, -4, 5), 350, 5), ((4, -2, 3), 220, 4), ((0, 3, 4), 250, 3)]:
        data = bpy.data.lights.new('Pose soft light', 'AREA')
        light = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(light)
        light.location, data.energy, data.size = location, energy, size
        light.rotation_euler = (Vector((0, 0, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()
        lights.append(light)
    data = bpy.data.cameras.new('Pose orthographic camera')
    data.type = 'ORTHO'
    data.ortho_scale = 2.45
    camera = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    rows = []
    for index, angle in enumerate(angles):
        angle = math.radians(angle)
        target = Vector((0, 0, 1))
        camera.location = (7 * math.sin(angle), -7 * math.cos(angle), 1)
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        bpy.context.view_layer.update()
        matrix = camera.matrix_world.to_3x3()
        row = {'image': str(output / f'pose-view-{index}.png'), 'scale': data.ortho_scale,
               'right': list(matrix @ Vector((1, 0, 0))), 'up': list(matrix @ Vector((0, 1, 0))),
               'target': list(target)}
        scene.render.filepath = row['image']
        bpy.ops.render.render(write_still=True)
        rows.append(row)
    for obj in [camera, *lights]:
        bpy.data.objects.remove(obj, do_unlink=True)
    return rows


def fit_posed(mesh, points, output):
    if not POSE_PYTHON.is_file() or not POSE_MODEL.is_file():
        raise ValueError('Для этой позы нужен локальный распознаватель суставов. Запустите scripts/Install-Pose.ps1.')
    size = np.ptp(points, axis=0)
    if not (0.2 < size[0] < 2.4 and size[1] < 1.8):
        raise ValueError('Выставьте человека вертикально и лицом вперёд. Голова и обе стопы должны быть видны целиком.')
    # Several angles are necessary: a single image can contain a confidently
    # hallucinated leg on an arm, while a different view misplaces only a wrist.
    views = render_views(mesh, output, angles=(0, -35, 35, -17.5, 17.5, -50, 50))
    (output / 'pose-views.json').write_text(json.dumps(views, indent=2), encoding='utf-8')
    result_path = output / 'pose-landmarks.json'
    with (output / 'pose-detection.log').open('wb') as log:
        result = subprocess.run([str(POSE_PYTHON), str(Path(__file__).with_name('detect_pose.py')),
            '--model', str(POSE_MODEL), '--output', str(result_path), *[view['image'] for view in views]],
            stdout=log, stderr=subprocess.STDOUT, timeout=120,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode or not result_path.is_file():
        raise ValueError('Локальное распознавание суставов не завершилось. Подробности есть в журнале подготовки скелета.')
    detections = json.loads(result_path.read_text(encoding='utf-8'))
    required = (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28)
    good = []
    for view, detection in zip(views, detections):
        landmarks = detection['landmarks']
        if not landmarks:
            continue
        confidence = np.mean([min(landmarks[i]['visibility'], landmarks[i]['presence']) for i in required])
        if confidence > 0.65:
            good.append((view, landmarks))
    if len(good) < 3:
        raise ValueError('Не удалось уверенно распознать обе руки и ноги. Поверните модель лицом вперёд; нужен человек в полный рост.')
    joints = {}
    errors = []
    joint_views = {}
    # Only fit landmarks actually used by the skeleton (nose/heels are unused).
    for index in sorted(set(required) | {7, 8, 17, 18, 19, 20, 31, 32}):
        observations = []
        for view, landmarks in good:
            point = landmarks[index]
            basis_rows, targets = [], []
            for basis, value in ((view['right'], (point['x'] - 0.5) * view['scale']),
                                 (view['up'], (0.5 - point['y']) * view['scale'])):
                basis_rows.append(basis)
                targets.append(value + np.dot(basis, view['target']))
            observations.append({'basis': basis_rows, 'target': targets,
                                 'confidence': min(point['visibility'], point['presence'])})
        try:
            location, agreement = triangulate_joint(observations)
        except ValueError as error:
            raise ValueError('Не удалось подтвердить положение суставов с нескольких ракурсов. Поверните модель лицом вперёд; руки и ноги должны быть видны отдельно.') from error
        errors.append(agreement['max_error_m'])
        joint_views[str(index)] = {**agreement, 'images': [Path(view['image']).name for view, _ in good]}
        distance = np.linalg.norm(points - location, axis=1)
        nearest = np.partition(distance, min(49, len(distance)-1))[min(49, len(distance)-1)]
        if index in required and nearest > 0.22:
            raise ValueError('Один из суставов оказался вне тела. Попробуйте другой поворот модели или изображение с раздельными конечностями.')
        # Surface samples surrounding the estimated joint put the pivot within
        # that limb, without collapsing all depth coordinates to the torso plane.
        close = points[distance < max(0.045, nearest * 1.5)]
        if len(close):
            location = location * 0.65 + np.median(close, axis=0) * 0.35
        joints[index] = location
    pelvis = (joints[23] + joints[24]) / 2
    shoulders = (joints[11] + joints[12]) / 2
    ears = (joints[7] + joints[8]) / 2
    if not (pelvis[2] < shoulders[2] < ears[2] and pelvis[2] > 0.65):
        raise ValueError('Скелет рассчитан на стоящего человека. Исправьте наклон модели перед созданием скелета.')
    # Anatomical left is +X in our export and in the SMPL-X mapping.
    if joints[11][0] <= joints[12][0]:
        raise ValueError('Модель повёрнута спиной. Разверните её на 180° вокруг вертикальной оси Y.')
    spine = pelvis + (shoulders - pelvis) * 0.32
    chest = pelvis + (shoulders - pelvis) * 0.72
    neck = shoulders + (ears - shoulders) * 0.4
    head = ears.copy()
    head_tip = head + (head - neck) / np.linalg.norm(head - neck) * 0.14
    spec = {'Hips': (pelvis, spine, None), 'Spine': (spine, chest, 'Hips'),
            'Chest': (chest, neck, 'Spine'), 'Neck': (neck, head, 'Chest'), 'Head': (head, head_tip, 'Neck')}
    for side, offset in (('L', 0), ('R', 1)):
        shoulder, elbow, wrist = (joints[i + offset] for i in (11, 13, 15))
        hand = (joints[17 + offset] + joints[19 + offset]) / 2
        hip, knee, ankle, toe = (joints[i + offset] for i in (23, 25, 27, 31))
        for first, second in ((shoulder, elbow), (elbow, wrist), (hip, knee), (knee, ankle)):
            if not 0.12 < np.linalg.norm(second - first) < 0.7:
                raise ValueError('Пропорции конечностей распознаны ненадёжно. Выставьте человека прямо и попробуйте ещё раз.')
        if np.linalg.norm(hand - wrist) < 0.06:
            hand = wrist + (wrist - elbow) / np.linalg.norm(wrist - elbow) * 0.10
        if np.linalg.norm(toe - ankle) < 0.06:
            toe = ankle + np.array([0, -0.12, -0.07])
        spec.update({f'UpperArm_{side}': (shoulder, elbow, 'Chest'),
            f'LowerArm_{side}': (elbow, wrist, f'UpperArm_{side}'),
            f'Hand_{side}': (wrist, hand, f'LowerArm_{side}'),
            f'UpperLeg_{side}': (hip, knee, 'Hips'),
            f'LowerLeg_{side}': (knee, ankle, f'UpperLeg_{side}'),
            f'Foot_{side}': (ankle, toe, f'LowerLeg_{side}')})
    diagnostics = {'method': 'MediaPipe Heavy landmarks triangulated from textured mesh renders',
        'automatic_semantic_recognition': True, 'valid_views': len(good),
        'joint_view_consensus': joint_views,
        'max_projection_error_m': max(errors), 'landmarks_blender': {str(k): v.tolist() for k, v in joints.items()},
        'input_requirements': 'One upright full-body human, facing +Z, complete separated limbs'}
    return spec, diagnostics
