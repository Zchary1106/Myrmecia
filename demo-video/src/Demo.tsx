import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const FPS = 30;
export const WIDTH = 1280;
export const HEIGHT = 720;
export const INTRO = 90;
export const SHOT = 132;
export const OUTRO = 96;

export function totalDuration(shotCount: number): number {
  return INTRO + shotCount * SHOT + OUTRO;
}

export interface Shot {
  id: string;
  nav: string;
  caption: string;
}

const BG = 'linear-gradient(135deg, #0b1020 0%, #0e1530 45%, #131a3a 100%)';
const ACCENT = '#54acf6';
const ACCENT2 = '#9f93ff';

const Background: React.FC = () => (
  <AbsoluteFill style={{ background: BG }}>
    <AbsoluteFill
      style={{
        background:
          'radial-gradient(1200px 600px at 50% -10%, rgba(84,172,246,0.18), transparent 60%)',
      }}
    />
  </AbsoluteFill>
);

const fadeInOut = (frame: number, duration: number, edge = 14): number => {
  return interpolate(
    frame,
    [0, edge, duration - edge, duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
};

const BrowserCard: React.FC<{ src: string; progress: number }> = ({ src, progress }) => {
  // Subtle Ken Burns zoom across the shot.
  const scale = interpolate(progress, [0, 1], [1.0, 1.06]);
  return (
    <div
      style={{
        width: 1120,
        height: 700,
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 40px 120px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)',
        background: '#0b1020',
      }}
    >
      <div
        style={{
          height: 34,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
          background: 'rgba(255,255,255,0.04)',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {['#ff5f56', '#ffbd2e', '#27c93f'].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: 999, background: c }} />
        ))}
        <div style={{ marginLeft: 12, color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>
          localhost:5173 — Myrmecia
        </div>
      </div>
      <div style={{ width: '100%', height: 666, overflow: 'hidden' }}>
        <Img
          src={src}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'top',
            transform: `scale(${scale})`,
            transformOrigin: 'top center',
          }}
        />
      </div>
    </div>
  );
};

const Caption: React.FC<{ text: string; frame: number; duration: number }> = ({ text, frame, duration }) => {
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const y = interpolate(enter, [0, 1], [30, 0]);
  const opacity = fadeInOut(frame, duration, 16);
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 70,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        transform: `translateY(${y}px)`,
        opacity,
      }}
    >
      <div
        style={{
          padding: '14px 28px',
          borderRadius: 999,
          background: 'rgba(10,14,30,0.72)',
          border: '1px solid rgba(255,255,255,0.10)',
          color: '#eef2ff',
          fontSize: 30,
          fontWeight: 600,
          letterSpacing: 0.2,
          backdropFilter: 'blur(6px)',
        }}
      >
        {text}
      </div>
    </div>
  );
};

const ShotScene: React.FC<{ shot: Shot }> = ({ shot }) => {
  const frame = useCurrentFrame();
  const progress = frame / SHOT;
  const opacity = fadeInOut(frame, SHOT, 14);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, transform: `translateY(${interpolate(opacity, [0, 1], [16, 0])}px)` }}>
        <BrowserCard src={staticFile(`frames/${shot.id}.png`)} progress={progress} />
      </div>
      <Caption text={shot.caption} frame={frame} duration={SHOT} />
    </AbsoluteFill>
  );
};

const Wordmark: React.FC<{ size?: number }> = ({ size = 76 }) => (
  <div
    style={{
      fontSize: size,
      fontWeight: 800,
      letterSpacing: 1,
      background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT2})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    }}
  >
    MYRMECIA
  </div>
);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 24 });
  const y = interpolate(enter, [0, 1], [24, 0]);
  const opacity = fadeInOut(frame, INTRO, 18);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', opacity, transform: `translateY(${y}px)` }}>
        <Wordmark />
        <div style={{ marginTop: 18, color: '#c7d2fe', fontSize: 34, fontWeight: 600 }}>
          Self-hosted Agent Ops
        </div>
        <div style={{ marginTop: 10, color: 'rgba(199,210,254,0.7)', fontSize: 22 }}>
          Run · Govern · Observe · Improve fleets of AI agents
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = fadeInOut(frame, OUTRO, 18);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', opacity }}>
        <Wordmark size={58} />
        <div style={{ marginTop: 22, color: '#eef2ff', fontSize: 30, fontWeight: 600 }}>
          Try it in one command
        </div>
        <div
          style={{
            marginTop: 16,
            display: 'inline-block',
            padding: '14px 26px',
            borderRadius: 12,
            background: 'rgba(10,14,30,0.7)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: ACCENT,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 26,
          }}
        >
          pnpm demo
        </div>
        <div style={{ marginTop: 22, color: 'rgba(199,210,254,0.8)', fontSize: 22 }}>
          github.com/Zchary1106/Myrmecia
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Demo: React.FC<{ shots: Shot[] }> = ({ shots }) => {
  return (
    <AbsoluteFill>
      <Background />
      <Sequence durationInFrames={INTRO}>
        <Intro />
      </Sequence>
      {shots.map((shot, i) => (
        <Sequence key={shot.id} from={INTRO + i * SHOT} durationInFrames={SHOT}>
          <ShotScene shot={shot} />
        </Sequence>
      ))}
      <Sequence from={INTRO + shots.length * SHOT} durationInFrames={OUTRO}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
