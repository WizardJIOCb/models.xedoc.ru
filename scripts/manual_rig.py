"""Validate manually placed landmarks and build the shared 17-bone contract.

Input points are on the oriented, normalized source mesh in glTF Y-up metres.
This module has no Blender, model inference, or file-system dependencies.
"""
import math

import numpy as np


POINT_LABELS = {'head': 'голова', 'neck': 'шея'}
for _side, _label in (('l', 'слева'), ('r', 'справа')):
    for _part, _name in (('shoulder', 'плечо'), ('elbow', 'локоть'), ('wrist', 'запястье'),
                         ('hand', 'конец кисти'), ('hip', 'тазобедренный сустав'),
                         ('knee', 'колено'), ('ankle', 'лодыжка'), ('toe', 'носок стопы')):
        POINT_LABELS[f'{_part}_{_side}'] = f'{_name} {_label}'
POINT_NAMES = tuple(POINT_LABELS)


def validate_manual(value, *, complete=True):
    """Return a detached JSON-safe input; drafts may omit landmarks."""
    if not isinstance(value, dict) or set(value) != {'version', 'points'}:
        raise ValueError('Нужны manual.version и manual.points с точками суставов.')
    if type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Поддерживается версия ручной разметки manual.version = 1.')
    points = value['points']
    if not isinstance(points, dict) or set(points) - set(POINT_NAMES):
        raise ValueError('Разметка содержит неизвестные точки суставов.')
    if complete and set(points) != set(POINT_NAMES):
        missing = ', '.join(POINT_LABELS[name] for name in POINT_NAMES if name not in points)
        raise ValueError(f'Отметьте все 18 точек. Не хватает: {missing}.')
    clean = {}
    for name, point in points.items():
        if not isinstance(point, (list, tuple)) or len(point) != 3 or any(
            isinstance(coordinate, bool) or not isinstance(coordinate, (int, float))
            or not -3 <= coordinate <= 3 or not math.isfinite(coordinate) for coordinate in point
        ):
            raise ValueError(f'Точка «{POINT_LABELS[name]}»: нужны три конечных числа от −3 до 3 метров.')
        clean[name] = [float(coordinate) for coordinate in point]
    result = {'version': 1, 'points': clean}
    if complete:
        _validate_anatomy(clean)
    return result


def _validate_anatomy(points):
    p = {name: np.asarray(point, dtype=float) for name, point in points.items()}

    def distance(first, second, low, high):
        length = float(np.linalg.norm(p[second] - p[first]))
        if not low <= length <= high:
            raise ValueError(f'Проверьте точки «{POINT_LABELS[first]}» и «{POINT_LABELS[second]}»: '
                             'они совпадают, слишком близки или слишком далеко друг от друга.')

    for side in ('l', 'r'):
        for first, second in (('shoulder', 'elbow'), ('elbow', 'wrist'), ('hip', 'knee'), ('knee', 'ankle')):
            distance(f'{first}_{side}', f'{second}_{side}', 0.06, 1.1)
        distance(f'wrist_{side}', f'hand_{side}', 0.025, 0.5)
        distance(f'ankle_{side}', f'toe_{side}', 0.025, 0.6)
        if not p[f'ankle_{side}'][1] + 0.03 < p[f'knee_{side}'][1] < p[f'hip_{side}'][1] - 0.03:
            raise ValueError('Для стоящего персонажа колени должны быть выше лодыжек и ниже таза.')
    distance('neck', 'head', 0.03, 0.5)
    distance('shoulder_l', 'shoulder_r', 0.08, 1.2)
    distance('hip_l', 'hip_r', 0.04, 0.9)
    pelvis = (p['hip_l'] + p['hip_r']) / 2
    shoulders = (p['shoulder_l'] + p['shoulder_r']) / 2
    if not 0.15 < np.linalg.norm(shoulders - pelvis) < 1.2:
        raise ValueError('Проверьте расстояние между тазом и плечами.')
    if not (pelvis[1] + 0.1 < shoulders[1] < p['neck'][1] - 0.01
            and p['neck'][1] + 0.025 < p['head'][1]):
        raise ValueError('Выставьте персонажа вертикально: плечи выше таза, шея выше плеч, голова выше шеи.')
    if p['shoulder_l'][0] <= p['shoulder_r'][0] + 0.02 or p['hip_l'][0] <= p['hip_r'][0] + 0.02:
        raise ValueError('Перепутаны стороны тела. Левая сторона персонажа находится справа на виде спереди.')
    if min(point[1] for point in p.values()) < -0.15 or max(point[1] for point in p.values()) > 2.2:
        raise ValueError('Точки должны находиться на модели высотой 2 метра, без смещения по сцене.')


def fit_manual(value):
    manual = validate_manual(value)
    # glTF Y-up -> Blender Z-up. Rotation/normalization already happened on
    # the mesh; applying the saved source rotation here would rotate twice.
    p = {name: np.array([point[0], -point[2], point[1]]) for name, point in manual['points'].items()}
    pelvis = (p['hip_l'] + p['hip_r']) / 2
    shoulders = (p['shoulder_l'] + p['shoulder_r']) / 2
    spine = pelvis + (shoulders - pelvis) * 0.32
    chest = pelvis + (shoulders - pelvis) * 0.72
    neck, head = p['neck'], p['head']
    head_tip = head + (head - neck) / np.linalg.norm(head - neck) * 0.12
    spec = {'Hips': (pelvis, spine, None), 'Spine': (spine, chest, 'Hips'),
            'Chest': (chest, neck, 'Spine'), 'Neck': (neck, head, 'Chest'),
            'Head': (head, head_tip, 'Neck')}
    for side, suffix in (('l', 'L'), ('r', 'R')):
        for name, first, second, parent in (
            ('UpperArm', 'shoulder', 'elbow', 'Chest'),
            ('LowerArm', 'elbow', 'wrist', f'UpperArm_{suffix}'),
            ('Hand', 'wrist', 'hand', f'LowerArm_{suffix}'),
            ('UpperLeg', 'hip', 'knee', 'Hips'),
            ('LowerLeg', 'knee', 'ankle', f'UpperLeg_{suffix}'),
            ('Foot', 'ankle', 'toe', f'LowerLeg_{suffix}'),
        ):
            spec[f'{name}_{suffix}'] = (p[f'{first}_{side}'], p[f'{second}_{side}'], parent)
    return spec, {'method': 'manual landmarks on normalized mesh', 'manual_landmarks': True,
                  'automatic_semantic_recognition': False, 'manual': manual}
