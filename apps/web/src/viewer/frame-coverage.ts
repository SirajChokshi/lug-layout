const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 36;
const CHANNEL_TOLERANCE = 3;
const RGBA_CHANNELS = 4;

export const MIN_SCENE_COVERAGE = 0.05;

export class FrameCoverage {
  private readonly context: CanvasRenderingContext2D;

  constructor(private readonly backgroundSrgb: number) {
    const sample = document.createElement("canvas");
    sample.width = SAMPLE_WIDTH;
    sample.height = SAMPLE_HEIGHT;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas unavailable for frame coverage sampling");
    this.context = context;
  }

  sceneFraction(source: HTMLCanvasElement): number {
    this.context.clearRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    this.context.drawImage(source, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const pixels = this.context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
    const red = (this.backgroundSrgb >> 16) & 0xff;
    const green = (this.backgroundSrgb >> 8) & 0xff;
    const blue = this.backgroundSrgb & 0xff;
    let scene = 0;
    for (let i = 0; i < pixels.length; i += RGBA_CHANNELS) {
      if ((pixels[i + 3] ?? 0) === 0) continue;
      const isBackground =
        Math.abs((pixels[i] ?? 0) - red) <= CHANNEL_TOLERANCE &&
        Math.abs((pixels[i + 1] ?? 0) - green) <= CHANNEL_TOLERANCE &&
        Math.abs((pixels[i + 2] ?? 0) - blue) <= CHANNEL_TOLERANCE;
      if (!isBackground) scene++;
    }
    return scene / (SAMPLE_WIDTH * SAMPLE_HEIGHT);
  }
}
