// s1tap: record what one process (Studio One / Studio Pro) plays, through a Core
// Audio process tap (macOS 14.2+). Nothing is installed and the app's output
// device is left alone; the tap is private and unmuted, so playback is heard as usual.
//
//   s1tap --pid <pid> --seconds <s> --out <file.wav>
//
// Writes a 32-bit float WAV at the tap's own rate and prints one JSON line:
// {"file", "sampleRate", "channels", "frames", "seconds", "peak"}. Errors go to
// stderr as {"error": "..."} with a non-zero exit. macOS asks once for
// permission to record system audio; until it is granted the tap delivers silence.
import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("{\"error\": \(String(reflecting: msg))}\n").data(using: .utf8)!)
    exit(1)
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

guard let pidText = arg("--pid"), let pid = pid_t(pidText) else { fail("--pid is required") }
guard let secText = arg("--seconds"), let seconds = Double(secText), seconds > 0, seconds <= 600 else { fail("--seconds must be 0 to 600") }
guard let out = arg("--out") else { fail("--out is required") }

func global(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

// The process's audio object exists once the process has opened audio.
var addr = global(kAudioHardwarePropertyTranslatePIDToProcessObject)
var qpid = pid
var processObject = AudioObjectID(kAudioObjectUnknown)
var size = UInt32(MemoryLayout<AudioObjectID>.size)
var st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &qpid, &size, &processObject)
if st != noErr || processObject == kAudioObjectUnknown { fail("process \(pid) has no audio object (is it running and playing audio?)") }

let tap = CATapDescription(stereoMixdownOfProcesses: [processObject])
tap.uuid = UUID()
tap.name = "s1tap"
tap.isPrivate = true
tap.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateProcessTap(tap, &tapID)
if st != noErr { fail("could not create the process tap (\(st))") }
defer { AudioHardwareDestroyProcessTap(tapID) }

// The tap's format (the mixdown is stereo float at the process's rate).
addr = global(kAudioTapPropertyFormat)
var asbd = AudioStreamBasicDescription()
size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
st = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd)
if st != noErr { fail("could not read the tap format (\(st))") }
let rate = asbd.mSampleRate
let channels = Int(asbd.mChannelsPerFrame)
let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
if asbd.mFormatID != kAudioFormatLinearPCM || asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
    fail("unexpected tap format")
}

// A private aggregate device that holds only the tap; its IO proc receives the audio.
let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "s1tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tap.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
st = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggID)
if st != noErr { fail("could not create the aggregate device (\(st))") }
defer { AudioHardwareDestroyAggregateDevice(aggID) }

// Preallocated: the IO proc only copies.
let total = Int(seconds * rate)
var planes = [[Float]](repeating: [Float](repeating: 0, count: total), count: channels)
var written = 0
let full = DispatchSemaphore(value: 0)
let lock = NSLock()

var procID: AudioDeviceIOProcID?
st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { _, input, _, _, _ in
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    lock.lock()
    defer { lock.unlock() }
    if written >= total { return }
    if interleaved, let b = abl.first, let data = b.mData {
        let p = data.assumingMemoryBound(to: Float.self)
        let n = min(Int(b.mDataByteSize) / (4 * channels), total - written)
        for f in 0..<n { for c in 0..<channels { planes[c][written + f] = p[f * channels + c] } }
        written += n
    } else {
        var n = 0
        for (c, b) in abl.enumerated() where c < channels {
            guard let data = b.mData else { continue }
            let p = data.assumingMemoryBound(to: Float.self)
            n = min(Int(b.mDataByteSize) / 4, total - written)
            for f in 0..<n { planes[c][written + f] = p[f] }
        }
        written += n
    }
    if written >= total { full.signal() }
}
if st != noErr { fail("could not create the IO proc (\(st))") }
st = AudioDeviceStart(aggID, procID)
if st != noErr { fail("could not start capture (\(st))") }
_ = full.wait(timeout: .now() + seconds + 5)
AudioDeviceStop(aggID, procID)
AudioDeviceDestroyIOProcID(aggID, procID!)

lock.lock()
let frames = written
lock.unlock()
if frames == 0 { fail("no audio arrived from the tap") }

guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: false),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { fail("could not make the output buffer") }
buffer.frameLength = AVAudioFrameCount(frames)
var peak: Float = 0
for c in 0..<channels {
    let dst = buffer.floatChannelData![c]
    for f in 0..<frames { dst[f] = planes[c][f]; peak = max(peak, abs(planes[c][f])) }
}
do {
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels,
        AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false,
    ]
    let file = try AVAudioFile(forWriting: URL(fileURLWithPath: out), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    try file.write(from: buffer)
} catch {
    fail("could not write \(out): \(error.localizedDescription)")
}
let peakDb = peak > 0 ? 20 * log10(Double(peak)) : -200
print("{\"file\": \(String(reflecting: out)), \"sampleRate\": \(rate), \"channels\": \(channels), \"frames\": \(frames), \"seconds\": \(Double(frames) / rate), \"peakDb\": \(String(format: "%.2f", peakDb))}")
