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


def swap_side_labels(manual):
    result = copy.deepcopy(manual)
    for part in ('shoulder', 'elbow', 'wrist', 'hand', 'hip', 'knee', 'ankle', 'toe'):
        left, right = f'{part}_l', f'{part}_r'
        result['points'][left], result['points'][right] = result['points'][right], result['points'][left]
    return result


def crossed_asymmetric_fixture():
    manual = manual_fixture()
    manual['points'].update({
        'shoulder_l': [.24, 1.58, .04], 'shoulder_r': [-.27, 1.55, -.02],
        'elbow_l': [.25, 1.27, .08], 'elbow_r': [-.28, 1.24, .12],
        'wrist_l': [-.18, 1.12, .19], 'wrist_r': [.2, 1.05, .25],
        'hand_l': [-.25, 1.09, .2], 'hand_r': [.28, 1.02, .27],
        'hip_l': [.14, .99, .02], 'hip_r': [-.16, 1., -.01],
        'knee_l': [-.07, .56, .02], 'knee_r': [.08, .59, .04],
        'ankle_l': [-.18, .14, .01], 'ankle_r': [.23, .12, .05],
        'toe_l': [-.2, .06, .18], 'toe_r': [.25, .05, .22],
    })
    return manual


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

    def test_mirrored_labels_are_corrected_as_whole_chains_without_moving_points(self):
        expected = crossed_asymmetric_fixture()
        mirrored = swap_side_labels(expected)
        baseline = copy.deepcopy(mirrored)
        result = validate_manual(mirrored)
        self.assertEqual(result, expected)
        self.assertEqual(mirrored, baseline)
        self.assertEqual(validate_manual(result), result)
        self.assertEqual(set(result), {'version', 'points'})
        # Wrists and legs cross the centre line; sorting each pair by X would
        # break these chains instead of recovering the intended labelling.
        self.assertLess(result['points']['wrist_l'][0], result['points']['wrist_r'][0])
        self.assertLess(result['points']['knee_l'][0], result['points']['knee_r'][0])
        for name in result['points']:
            self.assertFalse(any(result['points'][name] is point for point in mirrored['points'].values()))
        result['points']['shoulder_l'][0] = 2
        self.assertEqual(mirrored, baseline)

    def test_complete_and_partial_drafts_retain_mirrored_labels(self):
        for partial in (False, True):
            with self.subTest(partial=partial):
                mirrored = swap_side_labels(crossed_asymmetric_fixture())
                if partial:
                    del mirrored['points']['hand_r']
                baseline = copy.deepcopy(mirrored)
                draft = validate_manual(mirrored, complete=False)
                self.assertEqual(draft, baseline)
                draft['points']['shoulder_l'][0] = 2
                self.assertEqual(mirrored, baseline)

    def test_mixed_or_ambiguous_torso_sides_are_not_guessed(self):
        for part in ('shoulder', 'hip'):
            with self.subTest(mixed=part):
                manual = manual_fixture()
                left, right = f'{part}_l', f'{part}_r'
                manual['points'][left], manual['points'][right] = manual['points'][right], manual['points'][left]
                with self.assertRaisesRegex(ValueError, 'стороны'):
                    validate_manual(manual)
            for separation in (0., .019, .02):
                with self.subTest(ambiguous=part, separation=separation):
                    manual = swap_side_labels(manual_fixture())
                    # Depth keeps the joints distinct so this specifically
                    # exercises the side margin, not a bone-length failure.
                    manual['points'][f'{part}_l'][0] = -separation / 2
                    manual['points'][f'{part}_r'][0] = separation / 2
                    manual['points'][f'{part}_l'][2] = .1
                    manual['points'][f'{part}_r'][2] = -.1
                    baseline = copy.deepcopy(manual)
                    with self.assertRaisesRegex(ValueError, 'стороны'):
                        validate_manual(manual)
                    self.assertEqual(manual, baseline)

    def test_mirrored_labels_do_not_bypass_anatomy_validation(self):
        for first, second in (('wrist_l', 'elbow_l'), ('head', 'neck'), ('knee_r', 'ankle_r')):
            with self.subTest(first=first, second=second):
                manual = manual_fixture()
                manual['points'][first] = list(manual['points'][second])
                mirrored = swap_side_labels(manual)
                baseline = copy.deepcopy(mirrored)
                with self.assertRaises(ValueError):
                    validate_manual(mirrored)
                self.assertEqual(mirrored, baseline)

    def test_fit_manual_mirrored_pose_matches_the_correct_17_bone_contract(self):
        manual = crossed_asymmetric_fixture()
        expected, _ = fit_manual(manual)
        actual, diagnostics = fit_manual(swap_side_labels(manual))
        self.assertEqual(len(actual), 17)
        self.assertEqual(set(actual), set(expected))
        self.assertEqual(diagnostics['manual'], manual)
        self.assertTrue(diagnostics['manual_landmarks'])
        self.assertFalse(diagnostics['automatic_semantic_recognition'])
        for name, (head, tail, parent) in actual.items():
            with self.subTest(bone=name):
                np.testing.assert_allclose(head, expected[name][0])
                np.testing.assert_allclose(tail, expected[name][1])
                self.assertEqual(parent, expected[name][2])


if __name__ == '__main__':
    unittest.main()
