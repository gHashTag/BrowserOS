/**
 * Contract suite for the exports of useVoiceInput.ts.
 *
 * The module exports exactly one symbol: `useVoiceInput`. Every assertion
 * below drives that export through a real React root (react-dom/client
 * mounted on a minimal container, advanced with `act`) and asserts on the
 * state and results the hook exposes, so the suite pins observable
 * behaviour rather than the shape of the implementation.
 *
 * Export accounting (the module has 1 export in total):
 *   - exercised by assertions below: 1 (`useVoiceInput`)
 *   - not exercisable without a live dependency, and so listed here: 0
 *   - 1 + 0 = 1, matching the export count of the module.
 *
 * The hook's live dependencies are the browser capture stack
 * (navigator.mediaDevices.getUserMedia, MediaRecorder, AudioContext,
 * requestAnimationFrame) and the transcription gateway reached through
 * ./transcribe-audio. Each is replaced by an in-memory fake that honours
 * the same public surface, so the suite needs no network, no database and
 * no container, and the subject file is unmodified. The fakes expose
 * outcomes (a track's stopped flag, an AudioContext's closed flag) rather
 * than call counters, so assertions stay on the observable contract:
 * microphone release, error copy, transcript content and waveform values.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// ---------------------------------------------------------------------------
// Transcription stub: the hook must never reach the network from a test.
// ---------------------------------------------------------------------------

type TranscribeCall = { blob: Blob }

let transcribeCalls: TranscribeCall[] = []
let transcribeImpl: (blob: Blob) => Promise<string> = () => Promise.resolve('')

mock.module('./transcribe-audio', () => ({
  transcribeAudio: (blob: Blob): Promise<string> => {
    transcribeCalls.push({ blob })
    return transcribeImpl(blob)
  },
}))

const { useVoiceInput } = await import('./useVoiceInput')
type VoiceInput = ReturnType<typeof useVoiceInput>

// ---------------------------------------------------------------------------
// Fakes for the browser capture stack, installed on the global scope.
// ---------------------------------------------------------------------------

type FakeTrack = {
  stopped: boolean
  stop: () => void
}

type GrantedStream = {
  stream: MediaStream
  tracks: FakeTrack[]
}

const grantedStreams: GrantedStream[] = []

const micTracksAllStopped = (): boolean =>
  grantedStreams.every((granted) => granted.tracks.every((t) => t.stopped))

let getUserMediaImpl: (
  constraints: MediaStreamConstraints,
) => Promise<MediaStream>
const getUserMediaCalls: MediaStreamConstraints[] = []

const makeGrantedStream = (): GrantedStream => {
  const track: FakeTrack = {
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  const granted: GrantedStream = {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    tracks: [track],
  }
  grantedStreams.push(granted)
  return granted
}

const grantMicrophone = (): void => {
  getUserMediaImpl = (constraints) => {
    getUserMediaCalls.push(constraints)
    return Promise.resolve(makeGrantedStream().stream)
  }
}

const denyMicrophone = (failure: unknown): void => {
  getUserMediaImpl = () => Promise.reject(failure)
}

const namedError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name })

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static supportedMimeTypes = new Set(['audio/webm;codecs=opus', 'audio/webm'])
  static chunksOnStop: Blob[] = []
  static constructorError: Error | null = null

  static reset(): void {
    FakeMediaRecorder.instances = []
    FakeMediaRecorder.chunksOnStop = []
    FakeMediaRecorder.constructorError = null
    FakeMediaRecorder.supportedMimeTypes = new Set([
      'audio/webm;codecs=opus',
      'audio/webm',
    ])
  }

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supportedMimeTypes.has(type)
  }

  stream: MediaStream
  mimeType: string
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    if (FakeMediaRecorder.constructorError) {
      throw FakeMediaRecorder.constructorError
    }
    this.stream = stream
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    for (const chunk of FakeMediaRecorder.chunksOnStop) {
      this.ondataavailable?.({ data: chunk })
    }
    this.onstop?.()
  }
}

class FakeAnalyser {
  fftSize = 2048

  getByteTimeDomainData(target: Uint8Array): void {
    const frame = FakeAudioContext.frames.shift() ?? []
    for (let i = 0; i < target.length; i += 1) {
      target[i] = frame[i] ?? 128
    }
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static frames: number[][] = []

  static reset(): void {
    FakeAudioContext.instances = []
    FakeAudioContext.frames = []
  }

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  state: 'running' | 'closed' = 'running'
  closed = false

  close(): void {
    this.closed = true
    this.state = 'closed'
  }

  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser()
  }

  createMediaStreamSource(stream: MediaStream): {
    connect: (node: FakeAnalyser) => void
  } {
    this.analysedStream = stream
    return { connect: () => {} }
  }

  analysedStream: MediaStream | null = null
}

const animationFrameCallbacks: FrameRequestCallback[] = []
let animationFrameTicket = 0

/** Runs every queued animation-frame callback once, like a paint tick. */
const pumpAnimationFrame = (): void => {
  const callbacks = animationFrameCallbacks.splice(0)
  for (const callback of callbacks) callback(0)
}

const globalScope = globalThis as unknown as Record<string, unknown>
const windowWasMissing = typeof globalScope.window === 'undefined'
const rafWasMissing = typeof globalScope.requestAnimationFrame === 'undefined'

globalScope.IS_REACT_ACT_ENVIRONMENT = true
if (windowWasMissing) {
  globalScope.window = globalThis
}
globalScope.MediaRecorder = FakeMediaRecorder
globalScope.AudioContext = FakeAudioContext
if (rafWasMissing) {
  globalScope.requestAnimationFrame = (
    callback: FrameRequestCallback,
  ): number => {
    animationFrameTicket += 1
    animationFrameCallbacks.push(callback)
    return animationFrameTicket
  }
  globalScope.cancelAnimationFrame = (): void => {}
}
Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: (constraints: MediaStreamConstraints) =>
      getUserMediaImpl(constraints),
  },
  configurable: true,
})

afterAll(() => {
  mock.restore()
  delete globalScope.MediaRecorder
  delete globalScope.AudioContext
  delete globalScope.IS_REACT_ACT_ENVIRONMENT
  if (windowWasMissing) {
    delete globalScope.window
  }
  if (rafWasMissing) {
    delete globalScope.requestAnimationFrame
    delete globalScope.cancelAnimationFrame
  }
  delete (navigator as { mediaDevices?: unknown }).mediaDevices
})

// ---------------------------------------------------------------------------
// Waveform fixture: the subject bins the analyser's samples into five
// bands and normalises each band's peak to 0-100 (50 in raw amplitude is
// full scale, values above it clamp). frameFor builds one 256-sample
// frame whose band b carries the given raw peak everywhere in its bins.
// ---------------------------------------------------------------------------

const WAVEFORM_BIN_COUNT = 256

const bandStart = (band: number): number =>
  Math.floor((band / 5) * WAVEFORM_BIN_COUNT)

const frameFor = (bandPeaks: number[]): number[] => {
  const samples: number[] = Array<number>(WAVEFORM_BIN_COUNT).fill(128)
  bandPeaks.forEach((peak, band) => {
    for (let i = bandStart(band); i < bandStart(band + 1); i += 1) {
      samples[i] = 128 + peak
    }
  })
  return samples
}

// ---------------------------------------------------------------------------
// Hook driver: a real react-dom root on a minimal container object. The
// container only needs the surface react-dom touches for a component that
// renders nothing - event-listener installation and active-element
// tracking - so the hook runs under genuine React reconciliation and
// every state transition below is one the renderer produced.
// ---------------------------------------------------------------------------

const makeContainer = (): Element => {
  const fakeDocument = {
    nodeType: 9,
    activeElement: null,
    body: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const documentStub = {
    ...fakeDocument,
    document: fakeDocument,
    defaultView: { HTMLIFrameElement: class HTMLIFrameElement {} },
  }
  return {
    nodeType: 1,
    tagName: 'DIV',
    ownerDocument: documentStub,
    document: documentStub,
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => null,
    removeChild: () => null,
    insertBefore: () => null,
  } as unknown as Element
}

let latestVoice: VoiceInput | null = null
let mountedRoot: Root | null = null

const VoiceHarness = () => {
  latestVoice = useVoiceInput()
  return null
}

const mountVoice = async (): Promise<void> => {
  await act(async () => {
    const root = createRoot(makeContainer())
    mountedRoot = root
    root.render(createElement(VoiceHarness))
  })
}

const voice = (): VoiceInput => {
  if (!latestVoice) {
    throw new Error('the hook has not been mounted yet')
  }
  return latestVoice
}

/** Lets any suspended promise chains and queued React work settle. */
const settle = async (): Promise<void> => {
  await act(async () => {})
}

beforeEach(() => {
  transcribeCalls = []
  transcribeImpl = () => Promise.resolve('')
  FakeMediaRecorder.reset()
  FakeAudioContext.reset()
  animationFrameCallbacks.length = 0
  getUserMediaCalls.length = 0
  grantedStreams.length = 0
  grantMicrophone()
})

afterEach(async () => {
  const root = mountedRoot
  mountedRoot = null
  if (root) {
    await act(async () => {
      root.unmount()
    })
  }
  latestVoice = null
})

describe('useVoiceInputContract', () => {
  it('starts idle: not recording, not transcribing, empty transcript, silent waveform, no error', async () => {
    await mountVoice()

    expect(voice().isRecording).toBe(false)
    expect(voice().isTranscribing).toBe(false)
    expect(voice().transcript).toBe('')
    expect(voice().audioLevel).toBe(0)
    expect(voice().audioLevels).toEqual([0, 0, 0, 0, 0])
    expect(voice().error).toBeNull()
  })

  it('asks the platform for mono 16 kHz echo-cancelled audio and reports a live session', async () => {
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(true)
    expect(voice().isRecording).toBe(true)
    expect(getUserMediaCalls).toEqual([
      {
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      },
    ])
    const recorder = FakeMediaRecorder.instances.at(-1)
    expect(recorder?.mimeType).toBe('audio/webm;codecs=opus')
  })

  it('falls back to plain webm recording when the opus codec is unavailable', async () => {
    FakeMediaRecorder.supportedMimeTypes = new Set(['audio/webm'])
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(true)
    expect(voice().isRecording).toBe(true)
    const recorder = FakeMediaRecorder.instances.at(-1)
    expect(recorder?.mimeType).toBe('audio/webm')
  })

  it('publishes five live waveform bands from the analyser, and their average as the level', async () => {
    // Band peaks at 25 and 10 map to 50% and 20% of scale, 60 saturates to
    // 100%, band four is silent, and 15 maps to 30%.
    FakeAudioContext.frames.push(frameFor([25, 10, 60, 0, 15]))
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().audioLevels).toEqual([50, 20, 100, 0, 30])
    expect(voice().audioLevel).toBe(40)

    FakeAudioContext.frames.push(frameFor([0, 0, 0, 0, 0]))
    await act(async () => {
      pumpAnimationFrame()
    })
    expect(voice().audioLevels).toEqual([0, 0, 0, 0, 0])
    expect(voice().audioLevel).toBe(0)

    FakeAudioContext.frames.push(frameFor([50, 0, 0, 0, 0]))
    await act(async () => {
      pumpAnimationFrame()
    })
    expect(voice().audioLevels).toEqual([100, 0, 0, 0, 0])
    expect(voice().audioLevel).toBe(20)
  })

  it('reports a permission denial as a readable error and stays idle', async () => {
    denyMicrophone(
      namedError('NotAllowedError', 'The request is not allowed by the user'),
    )
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(false)
    expect(voice().isRecording).toBe(false)
    expect(voice().error).toBe('Microphone permission denied')
  })

  it('reports a missing microphone as a readable error and stays idle', async () => {
    denyMicrophone(namedError('NotFoundError', 'Requested device not found'))
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(false)
    expect(voice().isRecording).toBe(false)
    expect(voice().error).toBe('No microphone found')
  })

  it('surfaces the message of an unexpected start failure', async () => {
    denyMicrophone(new Error('audio driver crashed'))
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(false)
    expect(voice().error).toBe('audio driver crashed')
  })

  it('falls back to a generic start failure message for non-Error throws', async () => {
    denyMicrophone('just a string')
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(false)
    expect(voice().error).toBe('Failed to start recording')
  })

  it('releases the granted stream and the analyser when start-up fails after acquisition', async () => {
    FakeMediaRecorder.constructorError = new Error('recorder unavailable')
    await mountVoice()

    let started: boolean | undefined
    await act(async () => {
      started = await voice().startRecording()
    })

    expect(started).toBe(false)
    expect(voice().error).toBe('recorder unavailable')
    expect(voice().isRecording).toBe(false)
    expect(micTracksAllStopped()).toBe(true)
    const context = FakeAudioContext.instances.at(-1)
    expect(context?.closed).toBe(true)
  })

  it('clears the previous error and transcript when a new recording starts', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.resolve('hello there')
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })
    expect(voice().transcript).toBe('hello there')

    denyMicrophone(namedError('NotAllowedError', 'denied'))
    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().error).toBe('Microphone permission denied')

    grantMicrophone()
    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().error).toBeNull()
    expect(voice().transcript).toBe('')
  })

  it('does nothing when stopped while no recording is live', async () => {
    await mountVoice()

    await act(async () => {
      await voice().stopRecording()
    })

    expect(voice().isRecording).toBe(false)
    expect(voice().isTranscribing).toBe(false)
    expect(voice().error).toBeNull()
    expect(transcribeCalls).toHaveLength(0)
  })

  it('releases the microphone, flattens the waveform and lands the trimmed transcript', async () => {
    FakeMediaRecorder.chunksOnStop = [
      new Blob(['0123456789']),
      new Blob(['9876543210']),
    ]
    transcribeImpl = () => Promise.resolve('  it works  ')
    FakeAudioContext.frames.push(frameFor([60, 60, 60, 60, 60]))
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().audioLevels).toEqual([100, 100, 100, 100, 100])

    await act(async () => {
      await voice().stopRecording()
    })
    expect(voice().isRecording).toBe(false)
    expect(voice().transcript).toBe('it works')
    expect(voice().isTranscribing).toBe(false)
    expect(voice().audioLevels).toEqual([0, 0, 0, 0, 0])
    expect(voice().audioLevel).toBe(0)
    expect(micTracksAllStopped()).toBe(true)
    expect(transcribeCalls).toHaveLength(1)
    expect(transcribeCalls[0].blob.size).toBe(20)
    expect(transcribeCalls[0].blob.type).toBe('audio/webm')
  })

  it('holds isTranscribing for the duration of the transcription round-trip', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    let releaseTranscription: (text: string) => void = () => {}
    const gate = new Promise<string>((resolve) => {
      releaseTranscription = resolve
    })
    transcribeImpl = () => gate
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    let stopping: Promise<void> | null = null
    await act(async () => {
      stopping = voice().stopRecording()
    })
    await settle()
    expect(voice().isRecording).toBe(false)
    expect(voice().isTranscribing).toBe(true)

    await act(async () => {
      releaseTranscription('delayed but delivered')
      await stopping
    })
    expect(voice().isTranscribing).toBe(false)
    expect(voice().transcript).toBe('delayed but delivered')
  })

  it('reports an empty recording instead of transcribing nothing', async () => {
    FakeMediaRecorder.chunksOnStop = []
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })

    expect(voice().error).toBe('No audio recorded')
    expect(voice().transcript).toBe('')
    expect(voice().isTranscribing).toBe(false)
    expect(transcribeCalls).toHaveLength(0)
  })

  it('reports no speech when the transcription comes back blank', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.resolve('   \n\t ')
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })

    expect(voice().error).toBe('No speech detected')
    expect(voice().transcript).toBe('')
    expect(voice().isTranscribing).toBe(false)
  })

  it('surfaces the transcription error message', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.reject(new Error('gateway unreachable'))
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })

    expect(voice().error).toBe('gateway unreachable')
    expect(voice().transcript).toBe('')
    expect(voice().isTranscribing).toBe(false)
  })

  it('falls back to a generic transcription message for non-Error failures', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.reject('kaboom')
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })

    expect(voice().error).toBe('Transcription failed')
    expect(voice().isTranscribing).toBe(false)
  })

  it('clearTranscript wipes the transcript and any pending error', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.resolve('keep me')
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })
    expect(voice().transcript).toBe('keep me')

    await act(async () => {
      voice().clearTranscript()
    })
    expect(voice().transcript).toBe('')
    expect(voice().error).toBeNull()

    denyMicrophone(namedError('NotFoundError', 'gone'))
    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().error).toBe('No microphone found')

    await act(async () => {
      voice().clearTranscript()
    })
    expect(voice().error).toBeNull()
  })

  it('starts no second transcription when a finished session is stopped again', async () => {
    FakeMediaRecorder.chunksOnStop = [new Blob(['0123456789'])]
    transcribeImpl = () => Promise.resolve('once is enough')
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    await act(async () => {
      await voice().stopRecording()
    })
    expect(transcribeCalls).toHaveLength(1)

    await act(async () => {
      await voice().stopRecording()
    })
    expect(transcribeCalls).toHaveLength(1)
    expect(voice().transcript).toBe('once is enough')
    expect(voice().error).toBeNull()
  })

  it('stops the microphone, the recorder and the analyser when unmounted mid-recording', async () => {
    FakeAudioContext.frames.push(frameFor([25, 25, 25, 25, 25]))
    await mountVoice()

    await act(async () => {
      await voice().startRecording()
    })
    expect(voice().isRecording).toBe(true)

    const root = mountedRoot
    mountedRoot = null
    await act(async () => {
      root?.unmount()
    })

    expect(micTracksAllStopped()).toBe(true)
    const recorder = FakeMediaRecorder.instances.at(-1)
    expect(recorder?.state).toBe('inactive')
    const context = FakeAudioContext.instances.at(-1)
    expect(context?.closed).toBe(true)
  })
})
