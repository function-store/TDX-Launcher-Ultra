// Rendered generative preview loops for the demo gallery — one per flagship
// mock project, so tiles play real motion on hover instead of static blobs.
// Produced by a deterministic canvas renderer (5 scenes, 6 s seamless loops,
// 640×360 h264) — regenerate with scripts/hero/render-previews.mjs.

import auroraVideo from "./previews/aurora.mp4";
import auroraPoster from "./previews/aurora-poster.jpg";
import wallVideo from "./previews/particleWall.mp4";
import wallPoster from "./previews/particleWall-poster.jpg";
import kinectVideo from "./previews/kinect.mp4";
import kinectPoster from "./previews/kinect-poster.jpg";
import stageVideo from "./previews/stage.mp4";
import stagePoster from "./previews/stage-poster.jpg";
import audioVideo from "./previews/audio.mp4";
import audioPoster from "./previews/audio-poster.jpg";

export interface DemoPreview {
  video: string;
  poster: string;
}

/** Keyed by project display name (the `.toe` stem). */
export const DEMO_PREVIEWS: Record<string, DemoPreview> = {
  AuroraSet: { video: auroraVideo, poster: auroraPoster },
  ParticleWall: { video: wallVideo, poster: wallPoster },
  KinectRig: { video: kinectVideo, poster: kinectPoster },
  StageMapping: { video: stageVideo, poster: stagePoster },
  AudioReactive: { video: audioVideo, poster: audioPoster },
};
