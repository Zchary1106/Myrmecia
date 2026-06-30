import { Composition } from 'remotion';
import { Demo, FPS, HEIGHT, WIDTH, totalDuration } from './Demo';
import shots from '../shots.json';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={totalDuration(shots.length)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ shots }}
    />
  );
};
