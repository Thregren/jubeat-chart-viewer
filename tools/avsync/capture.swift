import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation

// Window video is independent of occlusion. Audio must use a display filter:
// filtering to the browser window/app misses its helper-process audio on macOS.
// Both streams supply host-clock PTS; preserve them in one AVAssetWriter session.
final class Capture: NSObject, SCStreamOutput {
 let writer: AVAssetWriter
 let video: AVAssetWriterInput
 let audio: AVAssetWriterInput
 var started=false
 var peak:Float=0
 var audioBuffers=0
 var videoFrames=0
 var dropped=0
 var failure:String?
 init(url:URL) throws {
  writer=try AVAssetWriter(outputURL:url,fileType:.mov)
  video=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:1280,AVVideoHeightKey:900,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:6_000_000]])
  audio=AVAssetWriterInput(mediaType:.audio,outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:48000,AVNumberOfChannelsKey:2,AVEncoderBitRateKey:192000])
  video.expectsMediaDataInRealTime=true;audio.expectsMediaDataInRealTime=true
  writer.add(video);writer.add(audio)
  super.init()
  guard writer.startWriting() else {throw writer.error!}
 }
 func stream(_ stream:SCStream,didOutputSampleBuffer sample:CMSampleBuffer,of type:SCStreamOutputType) {
  guard sample.isValid else {return}
  let input:AVAssetWriterInput
  if type == .screen {
   guard let info=CMSampleBufferGetSampleAttachmentsArray(sample,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],
    let status=info.first?[.status] as? Int,status==SCFrameStatus.complete.rawValue else {return}
   input=video
  } else if type == .audio {
   input=audio
   if let description=sample.formatDescription {
    let format=AVAudioFormat(cmAudioFormatDescription:description)
    if let pcm=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(sample.numSamples)) {
     pcm.frameLength=pcm.frameCapacity
     if CMSampleBufferCopyPCMDataIntoAudioBufferList(sample,at:0,frameCount:Int32(sample.numSamples),into:pcm.mutableAudioBufferList)==0,let channels=pcm.floatChannelData {
      for c in 0..<Int(format.channelCount) {for i in 0..<Int(pcm.frameLength){peak=max(peak,abs(channels[c][i]))}}
     }
    }
   }
  } else {return}
  if !started {writer.startSession(atSourceTime:sample.presentationTimeStamp);started=true}
  guard input.isReadyForMoreMediaData else {dropped+=1;return}
  if !input.append(sample){failure=writer.error?.localizedDescription ?? "append failed"}
  if type == .screen {videoFrames+=1}else{audioBuffers+=1}
 }
}
let app=NSApplication.shared
let args=CommandLine.arguments
guard args.count==3,let duration=Double(args[2]),duration>0,duration<=300 else {fputs("usage: capture output.mov seconds(1..300)\n",stderr);exit(2)}
let done=DispatchSemaphore(value:0)
Task {
 do {
  let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
  guard let window=content.windows.first(where:{$0.title?.contains("JUBEAT_AVSYNC")==true}) else {throw NSError(domain:"capture",code:1,userInfo:[NSLocalizedDescriptionKey:"Test window not found"])}
  let queue=DispatchQueue(label:"av-writer")
  let sink=try Capture(url:URL(fileURLWithPath:args[1]))
  let vc=SCStreamConfiguration();vc.width=1280;vc.height=900;vc.minimumFrameInterval=CMTime(value:1,timescale:60);vc.queueDepth=5;vc.showsCursor=false
  let vs=SCStream(filter:SCContentFilter(desktopIndependentWindow:window),configuration:vc,delegate:nil)
  let ac=SCStreamConfiguration();ac.width=2;ac.height=2;ac.minimumFrameInterval=CMTime(value:1,timescale:1);ac.capturesAudio=true;ac.sampleRate=48000;ac.channelCount=2;ac.captureMicrophone=false
  let aus=SCStream(filter:SCContentFilter(display:content.displays[0],excludingWindows:[]),configuration:ac,delegate:nil)
  try vs.addStreamOutput(sink,type:.screen,sampleHandlerQueue:queue)
  try aus.addStreamOutput(sink,type:.audio,sampleHandlerQueue:queue)
  try await vs.startCapture();try await aus.startCapture()
  print("CAPTURE_STARTED");fflush(stdout)
  try await Task.sleep(nanoseconds:UInt64(duration*1_000_000_000))
  try await aus.stopCapture();try await vs.stopCapture()
  queue.sync {sink.video.markAsFinished();sink.audio.markAsFinished()}
  await sink.writer.finishWriting()
  print("video frames=\(sink.videoFrames), audio buffers=\(sink.audioBuffers), peak=\(sink.peak), dropped=\(sink.dropped)")
  guard sink.writer.status == .completed,sink.failure == nil,sink.peak>0.001,sink.videoFrames>0,sink.dropped==0 else {
   throw NSError(domain:"capture",code:2,userInfo:[NSLocalizedDescriptionKey:sink.failure ?? sink.writer.error?.localizedDescription ?? "Missing audio/video or dropped buffers"])
  }
  print("CAPTURE_FINISHED")
 } catch {fputs("\(error)\n",stderr);exit(1)}
 done.signal()
}
done.wait()
