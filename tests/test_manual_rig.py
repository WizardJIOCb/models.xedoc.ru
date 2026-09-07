"""Manual landmarks: anatomy validation and glTF/Blender bone contract."""
import copy
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from manual_rig import fit_manual, validate_manual


def manual_fixture():
    points = {'head': [0, 1.85, 0.03], 'neck': [0, 1.67, 0]}
    for side, sign in (('l', 1), ('r', -1)):
        for name, point in {
            'shoulder': [0.24, 1.58, 0], 'elbow': [0.43, 1.27, 0],
            'wrist': [0.24, 1.08, 0.12], 'hand': [0.15, 1.04, 0.13],
            'hip': [0.14, 0.99, 0], 'knee': [0.2, 0.56, 0.02],
            'ankle': [0.22, 0.14, 0], 'toe': [0.23, 0.06, 0.18],
        }.items():
            points[f'{name}_{side}'] = [point[0] * sign, *point[1:]]
    return {'version': 1, 'points': points}


class ManualRigTests(unittest.TestCase):
    def test_bent_arms_build_existing_17_bone_contract_in_blender_coordinates(self):
        manual = manual_fixture()
        spec, diagnostics = fit_manual(manual)
        self.assertEqual(len(spec), 17)
        self.assertTrue(diagnostics['manual_landmarks'])
        self.assertFalse(diagnostics['automatic_semantic_recognition'])
        np.testing.assert_allclose(spec['LowerArm_L'][1], [.24, -.12, 1.08])
        np.testing.assert_allclose(spec['Foot_R'][1], [-.23, -.18, .06])
        np.testing.assert_allclose(spec['Hips'][0], [0, 0, .99])
        self.assertEqual(spec['Hand_L'][2], 'LowerArm_L')
        for head, tail, parent in spec.values():
            self.assertGreater(np.linalg.norm(tail - head), .025)
            self.assertTrue(parent is None or parent in spec)

    def test_drafts_allow_incomplete_points_but_generation_requires_every_joint(self):
        manual = {'version': 1, 'points': {'head': [0, 1.8, 0]}}
        self.assertEqual(validate_manual(manual, complete=False), manual)
        with self.assertRaisesRegex(ValueError, '18'):
            validate_manual(manual)
        self.assertEqual(validate_manual({'version': 1, 'points': {}}, complete=False)['points'], {})

    def test_bad_coordinates_and_contract_do_not_enter_numpy(self):
        for value in (True, '0', None, float('inf'), float('nan'), 10**400, -3.01):
            with self.subTest(value=value):
                manual = manual_fixture()
                manual['points']['head'][0] = value
                with self.assertRaises(ValueError):
                    validate_manual(manual)
        for invalid in ({'version': True, 'points': {}}, {'version': 2, 'points': {}},
                        {'version': 1, 'points': {'unknown': [0, 0, 0]}},
                        {'version': 1, 'points': {}, 'rotation': {}}, None):
            with self.assertRaises(ValueError):
                validate_manual(invalid, complete=False)

    def test_degenerate_bones_swapped_sides_and_wrong_hierarchy_are_rejected(self):
        for first, second in (('wrist_l', 'elbow_l'), ('head', 'neck'), ('knee_r', 'ankle_r')):
            manual = manual_fixture()
            manual['points'][first] = list(manual['points'][second])
            with self.assertRaises(ValueError):
                validate_manual(manual)
        manual = manual_fixture()
        manual['points']['shoulder_l'], manual['points']['shoulder_r'] = manual['points']['shoulder_r'], manual['points']['shoulder_l']
        with self.assertRaisesRegex(ValueError, 'стороны'):
            validate_manual(manual)
        manual = manual_fixture()
        manual['points']['neck'][1] = 1.55
        with self.assertRaisesRegex(ValueError, 'вертикально'):
            validate_manual(manual)

    def test_normalization_detaches_inputs_and_does_not_reapply_source_rotation(self):
        manual = manual_fixture()
        baseline = copy.deepcopy(manual)
        result = validate_manual(manual)
        result['points']['head'][0] = 1
        self.assertEqual(manual, baseline)
        spec, _ = fit_manual(manual)
        head = spec['Head'][0]
        np.testing.assert_allclose([head[0], head[2], -head[1]], manual['points']['head'])


if __name__ == '__main__':
    unittest.main()
