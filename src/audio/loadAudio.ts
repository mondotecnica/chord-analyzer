/**
 * 音声ファイルの読み込み。
 * ファイルはブラウザ内でのみ処理し、どこにもアップロードしない。
 */

export interface LoadedAudio {
  /** モノラル化したサンプル列（解析用） */
  monoSamples: Float32Array;
  sampleRate: number;
  duration: number;
  /** 再生用のオブジェクト URL（<audio> 要素で使う） */
  objectUrl: string;
  buffer: AudioBuffer;
}

export async function loadAudioFile(file: File): Promise<LoadedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("このブラウザは Web Audio API に対応していません。");
  }
  const ctx = new AudioCtx();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuffer);
  } catch {
    await ctx.close().catch(() => undefined);
    throw new Error(
      "音声ファイルをデコードできませんでした。対応形式（mp3 / wav / m4a / ogg / flac など）のファイルをお試しください。",
    );
  }
  await ctx.close().catch(() => undefined);

  // モノラルへダウンミックス
  const numChannels = buffer.numberOfChannels;
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < numChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < buffer.length; i++) {
      mono[i] += data[i] / numChannels;
    }
  }

  return {
    monoSamples: mono,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    objectUrl: URL.createObjectURL(file),
    buffer,
  };
}
