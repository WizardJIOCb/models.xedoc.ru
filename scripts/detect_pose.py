"""CPU pose inference in an isolated Python environment; images never leave this PC."""
import argparse
import json
from pathlib import Path

import mediapipe as mp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('images', nargs='+')
    args = parser.parse_args()
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=args.model),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, num_poses=1,
        min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5)
    rows = []
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
        for file in args.images:
            result = detector.detect(mp.Image.create_from_file(file))
            rows.append({'image': file, 'landmarks': [
                {key: float(getattr(point, key)) for key in ('x', 'y', 'z', 'visibility', 'presence')}
                for point in result.pose_landmarks[0]] if result.pose_landmarks else []})
    Path(args.output).write_text(json.dumps(rows, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
