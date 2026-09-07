"""Camera-based landmark fitting without trusting a detector's confidence alone."""
from itertools import combinations

import numpy as np


def align_frontal_landmarks(landmarks, view):
    """Resolve detector left/right flips in the user-aligned frontal camera arc.

    MediaPipe can reverse every anatomical label on a masked character, even
    between adjacent views. Our frontal renders look at the user's +Z-facing
    model, so the shoulder and hip pairs must both put anatomical left on +X.
    Ambiguous/crossed torso pairs are not evidence; discard that view. This is
    correspondence alignment, not a classifier of which way a person faces.
    """
    if len(landmarks) != 33 or float(view['right'][0]) < 0.6:
        raise ValueError('Expected landmarks from the frontal camera arc')
    shoulder = landmarks[11]['x'] - landmarks[12]['x']
    hip = landmarks[23]['x'] - landmarks[24]['x']
    if abs(shoulder) < 0.015 or abs(hip) < 0.015 or shoulder * hip <= 0:
        raise ValueError('Ambiguous left/right torso correspondence')
    aligned = [dict(point) for point in landmarks]
    swapped = shoulder < 0
    if swapped:
        pairs = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10)]
        pairs += [(i, i + 1) for i in range(11, 33, 2)]
        for left, right in pairs:
            aligned[left], aligned[right] = aligned[right], aligned[left]
    return aligned, swapped


def triangulate_joint(observations, *, min_views=3, tolerance=0.08):
    """Fit an orthographic landmark from a consensus of independent camera views.

    Each observation contains a 2x3 camera basis, a two-coordinate target and
    confidence. Hypotheses need angular separation and support from at least
    three views, so a confident false knee on a hand cannot dominate the fit.
    """
    reliable = [i for i, row in enumerate(observations) if row['confidence'] >= 0.5]
    required = max(min_views, len(reliable) // 2 + 1)
    if len(reliable) < required:
        raise ValueError('Not enough reliable views of this joint')

    def separated(indices):
        for a, b in combinations(indices, 2):
            # The rows are orthonormal camera right/up vectors.
            normal_a = np.cross(*observations[a]['basis'])
            normal_b = np.cross(*observations[b]['basis'])
            if abs(np.dot(normal_a, normal_b)) < np.cos(np.deg2rad(25)):
                return True
        return False

    def solve(indices):
        matrices, values = [], []
        for index in indices:
            row = observations[index]
            weight = row['confidence']
            matrices.extend(np.asarray(row['basis']) * weight)
            values.extend(np.asarray(row['target']) * weight)
        return np.linalg.lstsq(matrices, values, rcond=None)[0]

    def residuals(location):
        return np.array([np.linalg.norm(np.asarray(row['basis']) @ location - row['target'])
                         for row in observations])

    candidates = []
    for pair in combinations(reliable, 2):
        if not separated(pair):
            continue
        location = solve(pair)
        errors = residuals(location)
        inliers = [i for i in reliable if errors[i] <= tolerance]
        if len(inliers) < required or not separated(inliers):
            continue
        # Refine on the agreeing views only, then check support again.
        location = solve(inliers)
        errors = residuals(location)
        inliers = [i for i in reliable if errors[i] <= tolerance]
        if len(inliers) < required or not separated(inliers):
            continue
        location = solve(inliers)
        errors = residuals(location)
        if max(errors[inliers]) > tolerance:
            continue
        score = (-len(inliers), float(np.mean(errors[inliers] ** 2)))
        candidates.append((score, location, inliers, errors))
    if not candidates:
        raise ValueError('The camera views do not agree on this joint')
    _, location, inliers, errors = min(candidates, key=lambda item: item[0])
    return location, {'inliers': inliers, 'rejected': [i for i in range(len(observations)) if i not in inliers],
                      'max_error_m': float(max(errors[inliers])),
                      'errors_m': errors.tolist()}
