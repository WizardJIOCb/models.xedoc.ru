"""Numerical regression tests for high-confidence pose detection mistakes."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pose_geometry import align_frontal_landmarks, triangulate_joint


def cameras(point, angles=(0, -35, 35, -17.5, 17.5, -50, 50)):
    result = []
    for angle in np.deg2rad(angles):
        basis = np.array([[np.cos(angle), np.sin(angle), 0], [0, 0, 1]])
        result.append({'basis': basis, 'target': basis @ point, 'confidence': 0.98})
    return result


class PoseGeometryTests(unittest.TestCase):
    def test_adjacent_views_with_flipped_labels_recover_the_same_limb(self):
        left = np.array([0.3, -0.1, 1.5])
        right = np.array([-0.3, -0.1, 1.5])
        observations = []
        for index, camera in enumerate(cameras(left)):
            a, b = camera['basis'] @ left, camera['basis'] @ right
            points = [dict(x=0.5, y=0.5, visibility=0.98, presence=0.98) for _ in range(33)]
            for li, ri in ((11, 12), (23, 24)):
                points[li]['x'], points[ri]['x'] = 0.5 + a[0] / 2.45, 0.5 + b[0] / 2.45
                points[li]['y'] = points[ri]['y'] = 0.5 - (a[1] - 1) / 2.45
            flipped = index in (0, 1, 2, 4, 5)
            if flipped:
                for li, ri in ((11, 12), (23, 24)):
                    points[li], points[ri] = points[ri], points[li]
            before = [dict(p) for p in points]
            aligned, swapped = align_frontal_landmarks(points, {'right': camera['basis'][0]})
            self.assertEqual(swapped, flipped)
            self.assertEqual(points, before, 'Keep raw detector evidence intact')
            point = aligned[11]
            observations.append({**camera, 'target': [(point['x'] - 0.5) * 2.45, (0.5 - point['y']) * 2.45 + 1]})
        location, report = triangulate_joint(observations)
        np.testing.assert_allclose(location, left, atol=1e-7)
        self.assertEqual(len(report['inliers']), 7)

    def test_ambiguous_torso_or_rear_camera_is_not_silently_relabelled(self):
        points = [dict(x=0.5) for _ in range(33)]
        for li, ri in ((11, 12), (23, 24)):
            points[li]['x'], points[ri]['x'] = 0.6, 0.4
        with self.assertRaises(ValueError):
            align_frontal_landmarks(points, {'right': [-1, 0, 0]})
        points[23]['x'], points[24]['x'] = 0.4, 0.6
        with self.assertRaises(ValueError):
            align_frontal_landmarks(points, {'right': [1, 0, 0]})

    def test_confident_false_knee_on_upper_body_does_not_move_joint(self):
        point = np.array([0.28, -0.1, 0.6])
        observations = cameras(point)
        # The real failure: the frontal knee was detected a metre too high.
        observations[0]['target'] += [0.08, 1.0]
        observations[0]['confidence'] = 0.99
        # A second unrelated mistake must not force a guessed joint either.
        observations[3]['target'] += [-0.25, 0.35]
        fitted, diagnostics = triangulate_joint(observations)
        np.testing.assert_allclose(fitted, point, atol=1e-6)
        self.assertEqual(diagnostics['rejected'], [0, 3])

    def test_small_detection_noise_preserves_all_views(self):
        point = np.array([-0.35, 0.16, 1.35])
        observations = cameras(point)
        noise = np.random.default_rng(42).normal(0, 0.008, (len(observations), 2))
        for row, delta in zip(observations, noise):
            row['target'] += delta
        fitted, diagnostics = triangulate_joint(observations)
        np.testing.assert_allclose(fitted, point, atol=0.015)
        self.assertEqual(diagnostics['rejected'], [])

    def test_two_agreeing_views_do_not_override_an_inconsistent_majority(self):
        observations = cameras(np.array([0.2, 0.1, 0.5]))
        for index, row in enumerate(observations[2:]):
            row['target'] += [index * 0.2, (index + 1) * 0.3]
        with self.assertRaises(ValueError):
            triangulate_joint(observations)

    def test_duplicate_cameras_cannot_estimate_depth(self):
        with self.assertRaises(ValueError):
            triangulate_joint(cameras(np.array([0.2, 0.1, 0.5]), angles=(0, 1, 2, 3, 4)))

    def test_invisible_joints_are_not_evidence(self):
        observations = cameras(np.array([0.2, 0.1, 0.5]))
        for row in observations[2:]:
            row['confidence'] = 0.1
        with self.assertRaises(ValueError):
            triangulate_joint(observations)


if __name__ == '__main__':
    unittest.main()
